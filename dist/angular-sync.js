(function() {
"use strict";

angular
    .module('sync', ['socketio-auth']);
}());

(function() {
"use strict";

angular
    .module('sync')
    .factory('$syncGarbageCollector', syncGarbageCollector);

/**
 * safely remove deleted record/object from memory after the sync process disposed them.
 * 
 * TODO: Seconds should reflect the max time  that sync cache is valid (network loss would force a resync), which should match maxDisconnectionTimeBeforeDroppingSubscription on the server side.
 * 
 * Note:
 * removed record should be deleted from the sync internal cache after a while so that they do not stay in the memory. They cannot be removed too early as an older version/stamp of the record could be received after its removal...which would re-add to cache...due asynchronous processing...
 */
function syncGarbageCollector() {
    var items = [];
    var seconds = 2;
    var scheduled = false;

    var service = {
        setSeconds: setSeconds,
        getSeconds: getSeconds,
        dispose: dispose,
        schedule: schedule,
        run: run,
        getItemCount: getItemCount
    };

    return service;

    //////////

    function setSeconds(value) {
        seconds = value;
    }

    function getSeconds() {
        return seconds;
    }

    function getItemCount() {
        return items.length;
    }

    function dispose(collect) {
        items.push({
            timestamp: Date.now(),
            collect: collect
        });
        if (!scheduled) {
            service.schedule();
        }
    }

    function schedule() {
        if (!seconds) {
            service.run();
            return;
        }
        scheduled = true;
        setTimeout(function () {
            service.run();
            if (items.length > 0) {
                schedule();
            } else {
                scheduled = false;
            }
        }, seconds * 1000);
    }

    function run() {
        var timeout = Date.now() - seconds * 1000;
        while (items.length > 0 && items[0].timestamp <= timeout) {
            items.shift().collect();
        }
    }
}
}());

(function() {
"use strict";

angular
    .module('sync')
    .factory('$syncMerge', syncMerge);

function syncMerge() {

    return {
        update: updateObject,
        clearObject: clearObject
    }


    /**
     * This function updates an object with the content of another.
     * The inner objects and objects in array will also be updated.
     * References to the original objects are maintained in the destination object so Only content is updated.
     *
     * The properties in the source object that are not in the destination will be removed from the destination object.
     *
     * 
     *
     *@param <object> destination  object to update
     *@param <object> source  object to update from
     *@param <boolean> isStrictMode default false, if true would generate an error if inner objects in array do not have id field
     */
    function updateObject(destination, source, isStrictMode) {
        if (!destination) {
            return source;// _.assign({}, source);;
        }
        // create new object containing only the properties of source merge with destination
        var object = {};
        for (var property in source) {
            if (_.isArray(source[property])) {
                object[property] = updateArray(destination[property], source[property], isStrictMode);
            } else if (_.isFunction(source[property])) {
                object[property] = source[property];
            } else if (_.isObject(source[property]) && !_.isDate(source[property]) ) {
                object[property] = updateObject(destination[property], source[property], isStrictMode);
            } else {
                object[property] = source[property];
            }
        }

        clearObject(destination);
        _.assign(destination, object);

        return destination;
    }

    function updateArray(destination, source, isStrictMode) {
        if (!destination) {
            return source;
        }
        var array = [];
        source.forEach(function (item) {
            // does not try to maintain object references in arrays
            // super loose mode.
            if (isStrictMode==='NONE') {
                array.push(item);
            } else {
                // object in array must have an id otherwise we can't maintain the instance reference
                if (!_.isArray(item) && _.isObject(item)) {
                    // let try to find the instance
                    if (angular.isDefined(item.id)) {
                        array.push(updateObject(_.find(destination, function (obj) {
                            return obj.id.toString() === item.id.toString();
                        }), item, isStrictMode));
                    } else {
                        if (isStrictMode) {
                            throw new Error('objects in array must have an id otherwise we can\'t maintain the instance reference. ' + JSON.stringify(item));
                        }
                        array.push(item);
                    }
                } else {
                    array.push(item);
                }
            }
        });

        destination.length = 0;
        Array.prototype.push.apply(destination, array);
        //angular.copy(destination, array);
        return destination;
    }

    function clearObject(object) {
        Object.keys(object).forEach(function (key) { delete object[key]; });
    }
};
}());

(function() {
"use strict";

/**
 * 
 * Service that allows an array of data remain in sync with backend.
 * 
 * 
 * ex:
 * when there is a notification, noticationService notifies that there is something new...then the dataset get the data and notifies all its callback.
 * 
 * NOTE: 
 *  
 * 
 * Pre-Requiste:
 * -------------
 * Sync requires objects have BOTH id and revision fields/properties.
 * 
 * When the backend writes any data to the db that are supposed to be syncronized:
 * It must make sure each add, update, removal of record is timestamped.
 * It must notify the datastream (with notifyChange or notifyRemoval) with some params so that backend knows that it has to push back the data back to the subscribers (ex: the taskCreation would notify with its planId)
* 
 * 
 */
angular
    .module('sync')
    .provider('$sync', syncProvider);

function syncProvider() {

    var debug;

    this.setDebug = function (value) {
        debug = value;
    };

    this.$get = ["$rootScope", "$q", "$socketio", "$syncGarbageCollector", "$syncMerge", function sync($rootScope, $q, $socketio, $syncGarbageCollector, $syncMerge) {

        var publicationListeners = {},
            publicationListenerCount = 0;
        var GRACE_PERIOD_IN_SECONDS = 8;
        var SYNC_VERSION = '1.2';


        listenToSyncNotification();

        var service = {
            subscribe: subscribe,
            resolveSubscription: resolveSubscription,
            getGracePeriod: getGracePeriod,
            getIdValue: getIdValue
        };

        return service;

        ///////////////////////////////////
        /**
         * subscribe to publication and returns the subscription when data is available. 
         * @param publication name. on the server side, a publication shall exist. ex: magazines.sync
         * @param params   the params object passed to the subscription, ex: {magazineId:'entrepreneur'})
         * @param objectClass an instance of this class will be created for each record received.
         * returns a promise returning the subscription when the data is synced
         * or rejects if the initial sync fails to complete in a limited amount of time. 
         * 
         * to get the data from the dataSet, just dataSet.getData()
         */
        function resolveSubscription(publicationName, params, objectClass) {
            var deferred = $q.defer();
            var sDs = subscribe(publicationName).setObjectClass(objectClass);

            // give a little time for subscription to fetch the data...otherwise give up so that we don't get stuck in a resolve waiting forever.
            var gracePeriod = setTimeout(function () {
                if (!sDs.ready) {
                    sDs.destroy();
                    logInfo('Attempt to subscribe to publication ' + publicationName + ' failed');
                    deferred.reject('SYNC_TIMEOUT');
                }
            }, GRACE_PERIOD_IN_SECONDS * 1000);

            sDs.setParameters(params)
                .waitForDataReady()
                .then(function () {
                    clearTimeout(gracePeriod);
                    deferred.resolve(sDs);
                }).catch(function () {
                    clearTimeout(gracePeriod);
                    sDs.destroy();
                    deferred.reject('Failed to subscribe to publication ' + publicationName + ' failed');
                });
            return deferred.promise;
        }

        /**
         * 
         * for test purposes, returns the time resolveSubscription before it times out.
         */
        function getGracePeriod() {
            return GRACE_PERIOD_IN_SECONDS;
        }
        /**
         * subscribe to publication. It will not sync until you set the params.
         * 
         * @param publication name. on the server side, a publication shall exist. ex: magazines.sync
         * @param params   the params object passed to the subscription, ex: {magazineId:'entrepreneur'})
         * returns subscription
         * 
         */
        function subscribe(publicationName, scope) {
            return new Subscription(publicationName, scope);
        }



        ///////////////////////////////////
        // HELPERS

        // every sync notification comes thru the same event then it is dispatches to the targeted subscriptions.
        function listenToSyncNotification() {
            $socketio.on('SYNC_NOW', function (subNotification, fn) {
                logInfo('Syncing with subscription [name:' + subNotification.name + ', id:' + subNotification.subscriptionId + ' , params:' + JSON.stringify(subNotification.params) + ']. Records:' + subNotification.records.length + '[' + (subNotification.diff ? 'Diff' : 'All') + ']');
                var listeners = publicationListeners[subNotification.name];
                if (listeners) {
                    for (var listener in listeners) {
                        listeners[listener](subNotification);
                    }
                }
                fn('SYNCED'); // let know the backend the client was able to sync.
            });
        };


        // this allows a dataset to listen to any SYNC_NOW event..and if the notification is about its data.
        function addPublicationListener(streamName, callback) {
            var uid = publicationListenerCount++;
            var listeners = publicationListeners[streamName];
            if (!listeners) {
                publicationListeners[streamName] = listeners = {};
            }
            listeners[uid] = callback;

            return function () {
                delete listeners[uid];
            }
        }
        // ------------------------------------------------------
        // Subscription object
        // ------------------------------------------------------
        /**
         * a subscription synchronizes with the backend for any backend data change and makes that data available to a controller.
         * 
         *  When client subscribes to an syncronized api, any data change that impacts the api result WILL be PUSHed to the client.
         * If the client does NOT subscribe or stop subscribe, it will no longer receive the PUSH. 
         *    
         * if the connection is lost for a short time (duration defined on server-side), the server queues the changes if any. 
         * When the connection returns, the missing data automatically  will be PUSHed to the subscribing client.
         * if the connection is lost for a long time (duration defined on the server), the server will destroy the subscription. To simplify, the client will resubscribe at its reconnection and get all data.
         * 
         * subscription object provides 3 callbacks (add,update, del) which are called during synchronization.
         *      
         * Scope will allow the subscription stop synchronizing and cancel registration when it is destroyed. 
         *  
         * Constructor:
         * 
         * @param publication, the publication must exist on the server side
         * @param scope, by default $rootScope, but can be modified later on with attach method.
         */

        function Subscription(publication, scope) {
            var timestampField, isSyncingOn = false, isSingle, updateDataStorage, cache, isInitialPushCompleted, deferredInitialization, strictMode;
            var onReadyOff, formatRecord;
            var reconnectOff, publicationListenerOff, destroyOff;
            var objectClass;
            var subscriptionId;

            var sDs = this;
            var subParams = {};
            var recordStates = {};
            var innerScope;//= $rootScope.$new(true);
            var syncListener = new SyncListener();


            this.ready = false;
            this.syncOn = syncOn;
            this.syncOff = syncOff;
            this.setOnReady = setOnReady;

            this.onReady = onReady;
            this.onUpdate = onUpdate;
            this.onAdd = onAdd;
            this.onRemove = onRemove;

            this.getData = getData;
            this.setParameters = setParameters;

            this.waitForDataReady = waitForDataReady;
            this.waitForSubscriptionReady = waitForSubscriptionReady;

            this.setForce = setForce;
            this.isSyncing = isSyncing;
            this.isReady = isReady;

            this.setSingle = setSingle;

            this.setObjectClass = setObjectClass;
            this.getObjectClass = getObjectClass;

            this.setStrictMode = setStrictMode;

            this.attach = attach;
            this.destroy = destroy;

            this.isExistingStateFor = isExistingStateFor; // for testing purposes

            setSingle(false);

            // this will make sure that the subscription is released from servers if the app closes (close browser, refresh...)
            attach(scope || $rootScope);

            ///////////////////////////////////////////

            function destroy() {
                syncOff();
            }

            /** this will be called when data is available 
             *  it means right after each sync!
             * 
             * 
            */
            function setOnReady(callback) {
                if (onReadyOff) {
                    onReadyOff();
                }
                onReadyOff = onReady(callback);
                return sDs;
            }

            /**
             * force resyncing from scratch even if the parameters have not changed
             * 
             * if outside code has modified the data and you need to rollback, you could consider forcing a refresh with this. Better solution should be found than that.
             * 
             */
            function setForce(value) {
                if (value) {
                    // quick hack to force to reload...recode later.
                    sDs.syncOff();
                }
                return sDs;
            }

            /**
             * if set to true, if an object within an array property of the record to sync has no ID field.
             * an error would be thrown.
             * It is important if we want to be able to maintain instance references even for the objects inside arrays.
             *
             * Forces us to use id every where.
             *
             * Should be the default...but too restrictive for now.
             */
            function setStrictMode(value) {
                strictMode = value;
                return sDs;
            }

            /**
             * The following object will be built upon each record received from the backend
             * 
             * This cannot be modified after the sync has started.
             * 
             * @param classValue
             */
            function setObjectClass(classValue) {
                if (deferredInitialization) {
                    return sDs;
                }

                objectClass = classValue;
                formatRecord = function (record) {
                    return new objectClass(record);
                }
                setSingle(isSingle);
                return sDs;
            }

            function getObjectClass() {
                return objectClass;
            }

            /**
             * this function starts the syncing.
             * Only publication pushing data matching our fetching params will be received.
             * 
             * ex: for a publication named "magazines.sync", if fetching params equalled {magazinName:'cars'}, the magazine cars data would be received by this subscription.
             * 
             * @param fetchingParams
             * @param options
             * 
             * @returns a promise that resolves when data is arrived.
             */
            function setParameters(fetchingParams, options) {
                if (isSyncingOn && angular.equals(fetchingParams || {}, subParams)) {
                    // if the params have not changed, just returns with current data.
                    return sDs; //$q.resolve(getData());
                }
                syncOff();
                if (!isSingle) {
                    cache.length = 0;
                }

                subParams = fetchingParams || {};
                options = options || {};
                if (angular.isDefined(options.single)) {
                    setSingle(options.single);
                }
                syncOn();
                return sDs;
            }

            /**
             * @returns a promise that waits for the initial fetch to complete then wait for the initial fetch to complete then returns this subscription.
             */
            function waitForSubscriptionReady() {
                return syncOn().then(function () {
                    return sDs;
                });
            }

            /**
             * @returns a promise that waits for the initial fetch to complete then returns the data
             */
            function waitForDataReady() {
                return syncOn();
            }

            // does the dataset returns only one object? not an array?
            function setSingle(value) {
                if (deferredInitialization) {
                    return sDs;
                }

                var updateFn;
                isSingle = value;
                if (value) {
                    updateFn = updateSyncedObject;
                    cache = objectClass ? new objectClass({}) : {};
                } else {
                    updateFn = updateSyncedArray;
                    cache = [];
                }

                updateDataStorage = function (record) {
                    try {
                        updateFn(record);
                    } catch (e) {
                        e.message = 'Received Invalid object from publication [' + publication + ']: ' + JSON.stringify(record) + '. DETAILS: ' + e.message;
                        throw e;
                    }
                }

                return sDs;
            }

            // returns the object or array in sync
            function getData() {
                return cache;
            }

            /**
             * the dataset will start listening to the datastream 
             * 
             * Note During the sync, it will also call the optional callbacks - after processing EACH record received.
             * 
             * @returns a promise that will be resolved when the data is ready.
             */
            function syncOn() {
                if (isSyncingOn) {
                    return deferredInitialization.promise;
                }
                deferredInitialization = $q.defer();
                isInitialPushCompleted = false;
                logInfo('Sync ' + publication + ' on. Params:' + JSON.stringify(subParams));
                isSyncingOn = true;
                registerSubscription();
                readyForListening();
                return deferredInitialization.promise;
            }

            /**
             * the dataset is no longer listening and will not call any callback
             */
            function syncOff() {
                if (deferredInitialization) {
                    // if there is code waiting on this promise.. ex (load in resolve)
                    deferredInitialization.resolve(getData());
                }
                if (isSyncingOn) {
                    unregisterSubscription();
                    isSyncingOn = false;

                    logInfo('Sync ' + publication + ' off. Params:' + JSON.stringify(subParams));
                    if (publicationListenerOff) {
                        publicationListenerOff();
                        publicationListenerOff = null;
                    }
                    if (reconnectOff) {
                        reconnectOff();
                        reconnectOff = null;
                    }
                }
            }

            function isSyncing() {
                return isSyncingOn;
            }

            function readyForListening() {
                if (!publicationListenerOff) {
                    listenForReconnectionToResync();
                    listenToPublication();
                }
            }

            /**
             *  By default the rootscope is attached if no scope was provided. But it is possible to re-attach it to a different scope. if the subscription depends on a controller.
             *
             *  Do not attach after it has synced.
             */
            function attach(newScope) {
                if (deferredInitialization) {
                    return sDs;
                }
                if (destroyOff) {
                    destroyOff();
                }
                innerScope = newScope;
                destroyOff = innerScope.$on('$destroy', destroy);

                return sDs;
            }

            function listenForReconnectionToResync(listenNow) {
                // give a chance to connect before listening to reconnection... @TODO should have user_reconnected_event
                setTimeout(function () {
                    reconnectOff = innerScope.$on('user_connected', function () {
                        logDebug('Resyncing after network loss to ' + publication);
                        // note the backend might return a new subscription if the client took too much time to reconnect.
                        registerSubscription();
                    });
                }, listenNow ? 0 : 2000);
            }

            function registerSubscription() {
                $socketio.fetch('sync.subscribe', {
                    version: SYNC_VERSION,
                    id: subscriptionId, // to try to re-use existing subcription
                    publication: publication,
                    params: subParams
                }).then(function (subId) {
                    subscriptionId = subId;
                });
            }

            function unregisterSubscription() {
                if (subscriptionId) {
                    $socketio.fetch('sync.unsubscribe', {
                        version: SYNC_VERSION,
                        id: subscriptionId
                    });
                    subscriptionId = null;
                }
            }

            function listenToPublication() {
                // cannot only listen to subscriptionId yet...because the registration might have answer provided its id yet...but started broadcasting changes...@TODO can be improved...
                publicationListenerOff = addPublicationListener(publication, function (batch) {
                    if (subscriptionId === batch.subscriptionId || (!subscriptionId && checkDataSetParamsIfMatchingBatchParams(batch.params))) {
                        if (!batch.diff) {
                            // Clear the cache to rebuild it if all data was received.
                            recordStates = {};
                            if (!isSingle) {
                                cache.length = 0;
                            }
                        }
                        applyChanges(batch.records);
                        if (!isInitialPushCompleted) {
                            isInitialPushCompleted = true;
                            deferredInitialization.resolve(getData());
                        }
                    }
                });
            }

            /**
            * if the params of the dataset matches the notification, it means the data needs to be collect to update array.
            */
            function checkDataSetParamsIfMatchingBatchParams(batchParams) {
                // if (params.length != streamParams.length) {
                //     return false;
                // }
                if (!subParams || Object.keys(subParams).length == 0) {
                    return true
                }
                var matching = true;
                for (var param in batchParams) {
                    // are other params matching?
                    // ex: we might have receive a notification about taskId=20 but this subscription are only interested about taskId-3
                    if (batchParams[param] !== subParams[param]) {
                        matching = false;
                        break;
                    }
                }
                return matching;

            }

            // fetch all the missing records, and activate the call backs (add,update,remove) accordingly if there is something that is new or not already in sync.
            function applyChanges(records) {
                var newDataArray = [];
                var newData;
                sDs.ready = false;
                records.forEach(function (record) {
                    //                   logInfo('Datasync [' + dataStreamName + '] received:' +JSON.stringify(record));//+ JSON.stringify(record.id));
                    if (record.remove) {
                        removeRecord(record);
                    } else if (getRecordState(record)) {
                        // if the record is already present in the cache...so it is mightbe an update..
                        newData = updateRecord(record);
                    } else {
                        newData = addRecord(record);
                    }
                    if (newData) {
                        newDataArray.push(newData);
                    }
                });
                sDs.ready = true;
                if (isSingle) {
                    syncListener.notify('ready', getData());
                } else {
                    syncListener.notify('ready', getData(), newDataArray);
                }
            }

            /**
             * Although most cases are handled using onReady, this tells you the current data state.
             * 
             * @returns if true is a sync has been processed otherwise false if the data is not ready.
             */
            function isReady() {
                return this.ready;
            }
            /**
             * 
             * returns a function to remove the listener.
             */
            function onAdd(callback) {
                return syncListener.on('add', callback);
            }

            /**
             * 
             * returns a function to remove the listener.
             */
            function onUpdate(callback) {
                return syncListener.on('update', callback);
            }

            /**
             * 
             * returns a function to remove the listener.
             */
            function onRemove(callback) {
                return syncListener.on('remove', callback);
            }

            /**
             * 
             * returns a function to remove the listener.
             */
            function onReady(callback) {
                return syncListener.on('ready', callback);
            }


            function addRecord(record) {
                logDebug('Sync -> Inserted New record #' + JSON.stringify(record.id) + ' for subscription to ' + publication);// JSON.stringify(record));
                getRevision(record); // just make sure we can get a revision before we handle this record
                updateDataStorage(formatRecord ? formatRecord(record) : record);
                syncListener.notify('add', record);
                return record;
            }

            function updateRecord(record) {
                var previous = getRecordState(record);
                if (getRevision(record) <= getRevision(previous)) {
                    return null;
                }
                logDebug('Sync -> Updated record #' + JSON.stringify(record.id) + ' for subscription to ' + publication);// JSON.stringify(record));
                updateDataStorage(formatRecord ? formatRecord(record) : record);
                syncListener.notify('update', record);
                return record;
            }


            function removeRecord(record) {
                var previous = getRecordState(record);
                if (!previous || getRevision(record) > getRevision(previous)) {
                    logDebug('Sync -> Removed #' + JSON.stringify(record.id) + ' for subscription to ' + publication);
                    // We could have for the same record consecutively fetching in this order:
                    // delete id:4, rev 10, then add id:4, rev 9.... by keeping track of what was deleted, we will not add the record since it was deleted with a most recent timestamp.
                    record.removed = true; // So we only flag as removed, later on the garbage collector will get rid of it.         
                    updateDataStorage(record);
                    // if there is no previous record we do not need to removed any thing from our storage.     
                    if (previous) {
                        syncListener.notify('remove', record);
                        dispose(record);
                    }
                }
            }
            function dispose(record) {
                $syncGarbageCollector.dispose(function collect() {
                    var existingRecord = getRecordState(record);
                    if (existingRecord && record.revision >= existingRecord.revision
                    ) {
                        //logDebug('Collect Now:' + JSON.stringify(record));
                        delete recordStates[getIdValue(record.id)];
                    }
                });
            }

            function isExistingStateFor(record) {
                return !!getRecordState(record);
            }

            function saveRecordState(record) {
                recordStates[getIdValue(record.id)] = record;
            }

            function getRecordState(record) {
                return recordStates[getIdValue(record.id)];
            }

            function updateSyncedObject(record) {
                saveRecordState(record);

                if (!record.remove) {
                    $syncMerge.update(cache, record, strictMode);
                } else {
                    $syncMerge.clearObject(cache);
                }
            }

            function updateSyncedArray(record) {
                var existing = getRecordState(record);
                if (!existing) {
                    // add new instance
                    saveRecordState(record);
                    if (!record.removed) {
                        cache.push(record);
                    }
                } else {
                    $syncMerge.update(existing, record, strictMode);
                    if (record.removed) {
                        cache.splice(cache.indexOf(existing), 1);
                    }
                }
            }

            function getRevision(record) {
                // what reserved field do we use as timestamp
                if (angular.isDefined(record.revision)) {
                    return record.revision;
                }
                if (angular.isDefined(record.timestamp)) {
                    return record.timestamp;
                }
                throw new Error('Sync requires a revision or timestamp property in received ' + (objectClass ? 'object [' + objectClass.name + ']' : 'record'));
            }
        }

        /**
         * this object 
         */
        function SyncListener() {
            var events = {};
            var count = 0;

            this.notify = notify;
            this.on = on;

            function notify(event, data1, data2) {
                var listeners = events[event];
                if (listeners) {
                    _.forEach(listeners, function (callback, id) {
                        callback(data1, data2);
                    });
                }
            }

            /**
             * @returns handler to unregister listener
             */
            function on(event, callback) {
                var listeners = events[event];
                if (!listeners) {
                    listeners = events[event] = {};
                }
                var id = count++;
                listeners[id++] = callback;
                return function () {
                    delete listeners[id];
                }
            }
        }
    }];
    function getIdValue(id) {
        if (!_.isObject(id)) {
            return id;
        }
        // build composite key value
        var r = _.join(_.map(id, function (value) {
            return value;
        }), '~');
        return r;
    }


    function logInfo(msg) {
        if (debug) {
            console.debug('SYNC(info): ' + msg);
        }
    }

    function logDebug(msg) {
        if (debug == 2) {
            console.debug('SYNC(debug): ' + msg);
        }

    }



};
}());

//# sourceMappingURL=data:application/json;charset=utf8;base64,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QUNBLEtBQUEsVUFBQTs7WUFFQSxLQUFBLHFCQUFBOztZQUVBLFVBQUE7OztZQUdBLE9BQUEsU0FBQTs7OztZQUlBLFNBQUEsVUFBQTtnQkFDQTs7Ozs7Ozs7WUFRQSxTQUFBLFdBQUEsVUFBQTtnQkFDQSxJQUFBLFlBQUE7b0JBQ0E7O2dCQUVBLGFBQUEsUUFBQTtnQkFDQSxPQUFBOzs7Ozs7Ozs7WUFTQSxTQUFBLFNBQUEsT0FBQTtnQkFDQSxJQUFBLE9BQUE7O29CQUVBLElBQUE7O2dCQUVBLE9BQUE7Ozs7Ozs7Ozs7OztZQVlBLFNBQUEsY0FBQSxPQUFBO2dCQUNBLGFBQUE7Z0JBQ0EsT0FBQTs7Ozs7Ozs7OztZQVVBLFNBQUEsZUFBQSxZQUFBO2dCQUNBLElBQUEsd0JBQUE7b0JBQ0EsT0FBQTs7O2dCQUdBLGNBQUE7Z0JBQ0EsZUFBQSxVQUFBLFFBQUE7b0JBQ0EsT0FBQSxJQUFBLFlBQUE7O2dCQUVBLFVBQUE7Z0JBQ0EsT0FBQTs7O1lBR0EsU0FBQSxpQkFBQTtnQkFDQSxPQUFBOzs7Ozs7Ozs7Ozs7OztZQWNBLFNBQUEsY0FBQSxnQkFBQSxTQUFBO2dCQUNBLElBQUEsZUFBQSxRQUFBLE9BQUEsa0JBQUEsSUFBQSxZQUFBOztvQkFFQSxPQUFBOztnQkFFQTtnQkFDQSxJQUFBLENBQUEsVUFBQTtvQkFDQSxNQUFBLFNBQUE7OztnQkFHQSxZQUFBLGtCQUFBO2dCQUNBLFVBQUEsV0FBQTtnQkFDQSxJQUFBLFFBQUEsVUFBQSxRQUFBLFNBQUE7b0JBQ0EsVUFBQSxRQUFBOztnQkFFQTtnQkFDQSxPQUFBOzs7Ozs7WUFNQSxTQUFBLDJCQUFBO2dCQUNBLE9BQUEsU0FBQSxLQUFBLFlBQUE7b0JBQ0EsT0FBQTs7Ozs7OztZQU9BLFNBQUEsbUJBQUE7Z0JBQ0EsT0FBQTs7OztZQUlBLFNBQUEsVUFBQSxPQUFBO2dCQUNBLElBQUEsd0JBQUE7b0JBQ0EsT0FBQTs7O2dCQUdBLElBQUE7Z0JBQ0EsV0FBQTtnQkFDQSxJQUFBLE9BQUE7b0JBQ0EsV0FBQTtvQkFDQSxRQUFBLGNBQUEsSUFBQSxZQUFB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QUEsT0FBQTs7Ozs7Ozs7WUFRQSxTQUFBLEdBQUEsT0FBQSxVQUFBO2dCQUNBLElBQUEsWUFBQSxPQUFBO2dCQUNBLElBQUEsQ0FBQSxXQUFBO29CQUNBLFlBQUEsT0FBQSxTQUFBOztnQkFFQSxJQUFBLEtBQUE7Z0JBQ0EsVUFBQSxRQUFBO2dCQUNBLE9BQUEsWUFBQTtvQkFDQSxPQUFBLFVBQUE7Ozs7O0lBS0EsU0FBQSxXQUFBLElBQUE7UUFDQSxJQUFBLENBQUEsRUFBQSxTQUFBLEtBQUE7WUFDQSxPQUFBOzs7UUFHQSxJQUFBLElBQUEsRUFBQSxLQUFBLEVBQUEsSUFBQSxJQUFBLFVBQUEsT0FBQTtZQUNBLE9BQUE7WUFDQTtRQUNBLE9BQUE7Ozs7SUFJQSxTQUFBLFFBQUEsS0FBQTtRQUNBLElBQUEsT0FBQTtZQUNBLFFBQUEsTUFBQSxpQkFBQTs7OztJQUlBLFNBQUEsU0FBQSxLQUFBO1FBQ0EsSUFBQSxTQUFBLEdBQUE7WUFDQSxRQUFBLE1BQUEsa0JBQUE7Ozs7Ozs7Q0FPQTs7QUFFQSIsImZpbGUiOiJhbmd1bGFyLXN5bmMuanMiLCJzb3VyY2VzQ29udGVudCI6WyIoZnVuY3Rpb24oKSB7XG5cInVzZSBzdHJpY3RcIjtcblxuYW5ndWxhclxuICAgIC5tb2R1bGUoJ3N5bmMnLCBbJ3NvY2tldGlvLWF1dGgnXSk7XG59KCkpO1xuXG4oZnVuY3Rpb24oKSB7XG5cInVzZSBzdHJpY3RcIjtcblxuYW5ndWxhclxuICAgIC5tb2R1bGUoJ3N5bmMnKVxuICAgIC5mYWN0b3J5KCckc3luY0dhcmJhZ2VDb2xsZWN0b3InLCBzeW5jR2FyYmFnZUNvbGxlY3Rvcik7XG5cbi8qKlxuICogc2FmZWx5IHJlbW92ZSBkZWxldGVkIHJlY29yZC9vYmplY3QgZnJvbSBtZW1vcnkgYWZ0ZXIgdGhlIHN5bmMgcHJvY2VzcyBkaXNwb3NlZCB0aGVtLlxuICogXG4gKiBUT0RPOiBTZWNvbmRzIHNob3VsZCByZWZsZWN0IHRoZSBtYXggdGltZSAgdGhhdCBzeW5jIGNhY2hlIGlzIHZhbGlkIChuZXR3b3JrIGxvc3Mgd291bGQgZm9yY2UgYSByZXN5bmMpLCB3aGljaCBzaG91bGQgbWF0Y2ggbWF4RGlzY29ubmVjdGlvblRpbWVCZWZvcmVEcm9wcGluZ1N1YnNjcmlwdGlvbiBvbiB0aGUgc2VydmVyIHNpZGUuXG4gKiBcbiAqIE5vdGU6XG4gKiByZW1vdmVkIHJlY29yZCBzaG91bGQgYmUgZGVsZXRlZCBmcm9tIHRoZSBzeW5jIGludGVybmFsIGNhY2hlIGFmdGVyIGEgd2hpbGUgc28gdGhhdCB0aGV5IGRvIG5vdCBzdGF5IGluIHRoZSBtZW1vcnkuIFRoZXkgY2Fubm90IGJlIHJlbW92ZWQgdG9vIGVhcmx5IGFzIGFuIG9sZGVyIHZlcnNpb24vc3RhbXAgb2YgdGhlIHJlY29yZCBjb3VsZCBiZSByZWNlaXZlZCBhZnRlciBpdHMgcmVtb3ZhbC4uLndoaWNoIHdvdWxkIHJlLWFkZCB0byBjYWNoZS4uLmR1ZSBhc3luY2hyb25vdXMgcHJvY2Vzc2luZy4uLlxuICovXG5mdW5jdGlvbiBzeW5jR2FyYmFnZUNvbGxlY3RvcigpIHtcbiAgICB2YXIgaXRlbXMgPSBbXTtcbiAgICB2YXIgc2Vjb25kcyA9IDI7XG4gICAgdmFyIHNjaGVkdWxlZCA9IGZhbHNlO1xuXG4gICAgdmFyIHNlcnZpY2UgPSB7XG4gICAgICAgIHNldFNlY29uZHM6IHNldFNlY29uZHMsXG4gICAgICAgIGdldFNlY29uZHM6IGdldFNlY29uZHMsXG4gICAgICAgIGRpc3Bvc2U6IGRpc3Bvc2UsXG4gICAgICAgIHNjaGVkdWxlOiBzY2hlZHVsZSxcbiAgICAgICAgcnVuOiBydW4sXG4gICAgICAgIGdldEl0ZW1Db3VudDogZ2V0SXRlbUNvdW50XG4gICAgfTtcblxuICAgIHJldHVybiBzZXJ2aWNlO1xuXG4gICAgLy8vLy8vLy8vL1xuXG4gICAgZnVuY3Rpb24gc2V0U2Vjb25kcyh2YWx1ZSkge1xuICAgICAgICBzZWNvbmRzID0gdmFsdWU7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gZ2V0U2Vjb25kcygpIHtcbiAgICAgICAgcmV0dXJuIHNlY29uZHM7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gZ2V0SXRlbUNvdW50KCkge1xuICAgICAgICByZXR1cm4gaXRlbXMubGVuZ3RoO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIGRpc3Bvc2UoY29sbGVjdCkge1xuICAgICAgICBpdGVtcy5wdXNoKHtcbiAgICAgICAgICAgIHRpbWVzdGFtcDogRGF0ZS5ub3coKSxcbiAgICAgICAgICAgIGNvbGxlY3Q6IGNvbGxlY3RcbiAgICAgICAgfSk7XG4gICAgICAgIGlmICghc2NoZWR1bGVkKSB7XG4gICAgICAgICAgICBzZXJ2aWNlLnNjaGVkdWxlKCk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBmdW5jdGlvbiBzY2hlZHVsZSgpIHtcbiAgICAgICAgaWYgKCFzZWNvbmRzKSB7XG4gICAgICAgICAgICBzZXJ2aWNlLnJ1bigpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIHNjaGVkdWxlZCA9IHRydWU7XG4gICAgICAgIHNldFRpbWVvdXQoZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgc2VydmljZS5ydW4oKTtcbiAgICAgICAgICAgIGlmIChpdGVtcy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICAgICAgc2NoZWR1bGUoKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgc2NoZWR1bGVkID0gZmFsc2U7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0sIHNlY29uZHMgKiAxMDAwKTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBydW4oKSB7XG4gICAgICAgIHZhciB0aW1lb3V0ID0gRGF0ZS5ub3coKSAtIHNlY29uZHMgKiAxMDAwO1xuICAgICAgICB3aGlsZSAoaXRlbXMubGVuZ3RoID4gMCAmJiBpdGVtc1swXS50aW1lc3RhbXAgPD0gdGltZW91dCkge1xuICAgICAgICAgICAgaXRlbXMuc2hpZnQoKS5jb2xsZWN0KCk7XG4gICAgICAgIH1cbiAgICB9XG59XG59KCkpO1xuXG4oZnVuY3Rpb24oKSB7XG5cInVzZSBzdHJpY3RcIjtcblxuYW5ndWxhclxuICAgIC5tb2R1bGUoJ3N5bmMnKVxuICAgIC5mYWN0b3J5KCckc3luY01lcmdlJywgc3luY01lcmdlKTtcblxuZnVuY3Rpb24gc3luY01lcmdlKCkge1xuXG4gICAgcmV0dXJuIHtcbiAgICAgICAgdXBkYXRlOiB1cGRhdGVPYmplY3QsXG4gICAgICAgIGNsZWFyT2JqZWN0OiBjbGVhck9iamVjdFxuICAgIH1cblxuXG4gICAgLyoqXG4gICAgICogVGhpcyBmdW5jdGlvbiB1cGRhdGVzIGFuIG9iamVjdCB3aXRoIHRoZSBjb250ZW50IG9mIGFub3RoZXIuXG4gICAgICogVGhlIGlubmVyIG9iamVjdHMgYW5kIG9iamVjdHMgaW4gYXJyYXkgd2lsbCBhbHNvIGJlIHVwZGF0ZWQuXG4gICAgICogUmVmZXJlbmNlcyB0byB0aGUgb3JpZ2luYWwgb2JqZWN0cyBhcmUgbWFpbnRhaW5lZCBpbiB0aGUgZGVzdGluYXRpb24gb2JqZWN0IHNvIE9ubHkgY29udGVudCBpcyB1cGRhdGVkLlxuICAgICAqXG4gICAgICogVGhlIHByb3BlcnRpZXMgaW4gdGhlIHNvdXJjZSBvYmplY3QgdGhhdCBhcmUgbm90IGluIHRoZSBkZXN0aW5hdGlvbiB3aWxsIGJlIHJlbW92ZWQgZnJvbSB0aGUgZGVzdGluYXRpb24gb2JqZWN0LlxuICAgICAqXG4gICAgICogXG4gICAgICpcbiAgICAgKkBwYXJhbSA8b2JqZWN0PiBkZXN0aW5hdGlvbiAgb2JqZWN0IHRvIHVwZGF0ZVxuICAgICAqQHBhcmFtIDxvYmplY3Q+IHNvdXJjZSAgb2JqZWN0IHRvIHVwZGF0ZSBmcm9tXG4gICAgICpAcGFyYW0gPGJvb2xlYW4+IGlzU3RyaWN0TW9kZSBkZWZhdWx0IGZhbHNlLCBpZiB0cnVlIHdvdWxkIGdlbmVyYXRlIGFuIGVycm9yIGlmIGlubmVyIG9iamVjdHMgaW4gYXJyYXkgZG8gbm90IGhhdmUgaWQgZmllbGRcbiAgICAgKi9cbiAgICBmdW5jdGlvbiB1cGRhdGVPYmplY3QoZGVzdGluYXRpb24sIHNvdXJjZSwgaXNTdHJpY3RNb2RlKSB7XG4gICAgICAgIGlmICghZGVzdGluYXRpb24pIHtcbiAgICAgICAgICAgIHJldHVybiBzb3VyY2U7Ly8gXy5hc3NpZ24oe30sIHNvdXJjZSk7O1xuICAgICAgICB9XG4gICAgICAgIC8vIGNyZWF0ZSBuZXcgb2JqZWN0IGNvbnRhaW5pbmcgb25seSB0aGUgcHJvcGVydGllcyBvZiBzb3VyY2UgbWVyZ2Ugd2l0aCBkZXN0aW5hdGlvblxuICAgICAgICB2YXIgb2JqZWN0ID0ge307XG4gICAgICAgIGZvciAodmFyIHByb3BlcnR5IGluIHNvdXJjZSkge1xuICAgICAgICAgICAgaWYgKF8uaXNBcnJheShzb3VyY2VbcHJvcGVydHldKSkge1xuICAgICAgICAgICAgICAgIG9iamVjdFtwcm9wZXJ0eV0gPSB1cGRhdGVBcnJheShkZXN0aW5hdGlvbltwcm9wZXJ0eV0sIHNvdXJjZVtwcm9wZXJ0eV0sIGlzU3RyaWN0TW9kZSk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKF8uaXNGdW5jdGlvbihzb3VyY2VbcHJvcGVydHldKSkge1xuICAgICAgICAgICAgICAgIG9iamVjdFtwcm9wZXJ0eV0gPSBzb3VyY2VbcHJvcGVydHldO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChfLmlzT2JqZWN0KHNvdXJjZVtwcm9wZXJ0eV0pICYmICFfLmlzRGF0ZShzb3VyY2VbcHJvcGVydHldKSApIHtcbiAgICAgICAgICAgICAgICBvYmplY3RbcHJvcGVydHldID0gdXBkYXRlT2JqZWN0KGRlc3RpbmF0aW9uW3Byb3BlcnR5XSwgc291cmNlW3Byb3BlcnR5XSwgaXNTdHJpY3RNb2RlKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgb2JqZWN0W3Byb3BlcnR5XSA9IHNvdXJjZVtwcm9wZXJ0eV07XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBjbGVhck9iamVjdChkZXN0aW5hdGlvbik7XG4gICAgICAgIF8uYXNzaWduKGRlc3RpbmF0aW9uLCBvYmplY3QpO1xuXG4gICAgICAgIHJldHVybiBkZXN0aW5hdGlvbjtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiB1cGRhdGVBcnJheShkZXN0aW5hdGlvbiwgc291cmNlLCBpc1N0cmljdE1vZGUpIHtcbiAgICAgICAgaWYgKCFkZXN0aW5hdGlvbikge1xuICAgICAgICAgICAgcmV0dXJuIHNvdXJjZTtcbiAgICAgICAgfVxuICAgICAgICB2YXIgYXJyYXkgPSBbXTtcbiAgICAgICAgc291cmNlLmZvckVhY2goZnVuY3Rpb24gKGl0ZW0pIHtcbiAgICAgICAgICAgIC8vIGRvZXMgbm90IHRyeSB0byBtYWludGFpbiBvYmplY3QgcmVmZXJlbmNlcyBpbiBhcnJheXNcbiAgICAgICAgICAgIC8vIHN1cGVyIGxvb3NlIG1vZGUuXG4gICAgICAgICAgICBpZiAoaXNTdHJpY3RNb2RlPT09J05PTkUnKSB7XG4gICAgICAgICAgICAgICAgYXJyYXkucHVzaChpdGVtKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgLy8gb2JqZWN0IGluIGFycmF5IG11c3QgaGF2ZSBhbiBpZCBvdGhlcndpc2Ugd2UgY2FuJ3QgbWFpbnRhaW4gdGhlIGluc3RhbmNlIHJlZmVyZW5jZVxuICAgICAgICAgICAgICAgIGlmICghXy5pc0FycmF5KGl0ZW0pICYmIF8uaXNPYmplY3QoaXRlbSkpIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gbGV0IHRyeSB0byBmaW5kIHRoZSBpbnN0YW5jZVxuICAgICAgICAgICAgICAgICAgICBpZiAoYW5ndWxhci5pc0RlZmluZWQoaXRlbS5pZCkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGFycmF5LnB1c2godXBkYXRlT2JqZWN0KF8uZmluZChkZXN0aW5hdGlvbiwgZnVuY3Rpb24gKG9iaikge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJldHVybiBvYmouaWQudG9TdHJpbmcoKSA9PT0gaXRlbS5pZC50b1N0cmluZygpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfSksIGl0ZW0sIGlzU3RyaWN0TW9kZSkpO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGlzU3RyaWN0TW9kZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignb2JqZWN0cyBpbiBhcnJheSBtdXN0IGhhdmUgYW4gaWQgb3RoZXJ3aXNlIHdlIGNhblxcJ3QgbWFpbnRhaW4gdGhlIGluc3RhbmNlIHJlZmVyZW5jZS4gJyArIEpTT04uc3RyaW5naWZ5KGl0ZW0pKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIGFycmF5LnB1c2goaXRlbSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBhcnJheS5wdXNoKGl0ZW0pO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfSk7XG5cbiAgICAgICAgZGVzdGluYXRpb24ubGVuZ3RoID0gMDtcbiAgICAgICAgQXJyYXkucHJvdG90eXBlLnB1c2guYXBwbHkoZGVzdGluYXRpb24sIGFycmF5KTtcbiAgICAgICAgLy9hbmd1bGFyLmNvcHkoZGVzdGluYXRpb24sIGFycmF5KTtcbiAgICAgICAgcmV0dXJuIGRlc3RpbmF0aW9uO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIGNsZWFyT2JqZWN0KG9iamVjdCkge1xuICAgICAgICBPYmplY3Qua2V5cyhvYmplY3QpLmZvckVhY2goZnVuY3Rpb24gKGtleSkgeyBkZWxldGUgb2JqZWN0W2tleV07IH0pO1xuICAgIH1cbn07XG59KCkpO1xuXG4oZnVuY3Rpb24oKSB7XG5cInVzZSBzdHJpY3RcIjtcblxuLyoqXG4gKiBcbiAqIFNlcnZpY2UgdGhhdCBhbGxvd3MgYW4gYXJyYXkgb2YgZGF0YSByZW1haW4gaW4gc3luYyB3aXRoIGJhY2tlbmQuXG4gKiBcbiAqIFxuICogZXg6XG4gKiB3aGVuIHRoZXJlIGlzIGEgbm90aWZpY2F0aW9uLCBub3RpY2F0aW9uU2VydmljZSBub3RpZmllcyB0aGF0IHRoZXJlIGlzIHNvbWV0aGluZyBuZXcuLi50aGVuIHRoZSBkYXRhc2V0IGdldCB0aGUgZGF0YSBhbmQgbm90aWZpZXMgYWxsIGl0cyBjYWxsYmFjay5cbiAqIFxuICogTk9URTogXG4gKiAgXG4gKiBcbiAqIFByZS1SZXF1aXN0ZTpcbiAqIC0tLS0tLS0tLS0tLS1cbiAqIFN5bmMgcmVxdWlyZXMgb2JqZWN0cyBoYXZlIEJPVEggaWQgYW5kIHJldmlzaW9uIGZpZWxkcy9wcm9wZXJ0aWVzLlxuICogXG4gKiBXaGVuIHRoZSBiYWNrZW5kIHdyaXRlcyBhbnkgZGF0YSB0byB0aGUgZGIgdGhhdCBhcmUgc3VwcG9zZWQgdG8gYmUgc3luY3Jvbml6ZWQ6XG4gKiBJdCBtdXN0IG1ha2Ugc3VyZSBlYWNoIGFkZCwgdXBkYXRlLCByZW1vdmFsIG9mIHJlY29yZCBpcyB0aW1lc3RhbXBlZC5cbiAqIEl0IG11c3Qgbm90aWZ5IHRoZSBkYXRhc3RyZWFtICh3aXRoIG5vdGlmeUNoYW5nZSBvciBub3RpZnlSZW1vdmFsKSB3aXRoIHNvbWUgcGFyYW1zIHNvIHRoYXQgYmFja2VuZCBrbm93cyB0aGF0IGl0IGhhcyB0byBwdXNoIGJhY2sgdGhlIGRhdGEgYmFjayB0byB0aGUgc3Vic2NyaWJlcnMgKGV4OiB0aGUgdGFza0NyZWF0aW9uIHdvdWxkIG5vdGlmeSB3aXRoIGl0cyBwbGFuSWQpXG4qIFxuICogXG4gKi9cbmFuZ3VsYXJcbiAgICAubW9kdWxlKCdzeW5jJylcbiAgICAucHJvdmlkZXIoJyRzeW5jJywgc3luY1Byb3ZpZGVyKTtcblxuZnVuY3Rpb24gc3luY1Byb3ZpZGVyKCkge1xuXG4gICAgdmFyIGRlYnVnO1xuXG4gICAgdGhpcy5zZXREZWJ1ZyA9IGZ1bmN0aW9uICh2YWx1ZSkge1xuICAgICAgICBkZWJ1ZyA9IHZhbHVlO1xuICAgIH07XG5cbiAgICB0aGlzLiRnZXQgPSBmdW5jdGlvbiBzeW5jKCRyb290U2NvcGUsICRxLCAkc29ja2V0aW8sICRzeW5jR2FyYmFnZUNvbGxlY3RvciwgJHN5bmNNZXJnZSkge1xuXG4gICAgICAgIHZhciBwdWJsaWNhdGlvbkxpc3RlbmVycyA9IHt9LFxuICAgICAgICAgICAgcHVibGljYXRpb25MaXN0ZW5lckNvdW50ID0gMDtcbiAgICAgICAgdmFyIEdSQUNFX1BFUklPRF9JTl9TRUNPTkRTID0gODtcbiAgICAgICAgdmFyIFNZTkNfVkVSU0lPTiA9ICcxLjInO1xuXG5cbiAgICAgICAgbGlzdGVuVG9TeW5jTm90aWZpY2F0aW9uKCk7XG5cbiAgICAgICAgdmFyIHNlcnZpY2UgPSB7XG4gICAgICAgICAgICBzdWJzY3JpYmU6IHN1YnNjcmliZSxcbiAgICAgICAgICAgIHJlc29sdmVTdWJzY3JpcHRpb246IHJlc29sdmVTdWJzY3JpcHRpb24sXG4gICAgICAgICAgICBnZXRHcmFjZVBlcmlvZDogZ2V0R3JhY2VQZXJpb2QsXG4gICAgICAgICAgICBnZXRJZFZhbHVlOiBnZXRJZFZhbHVlXG4gICAgICAgIH07XG5cbiAgICAgICAgcmV0dXJuIHNlcnZpY2U7XG5cbiAgICAgICAgLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy9cbiAgICAgICAgLyoqXG4gICAgICAgICAqIHN1YnNjcmliZSB0byBwdWJsaWNhdGlvbiBhbmQgcmV0dXJucyB0aGUgc3Vic2NyaXB0aW9uIHdoZW4gZGF0YSBpcyBhdmFpbGFibGUuIFxuICAgICAgICAgKiBAcGFyYW0gcHVibGljYXRpb24gbmFtZS4gb24gdGhlIHNlcnZlciBzaWRlLCBhIHB1YmxpY2F0aW9uIHNoYWxsIGV4aXN0LiBleDogbWFnYXppbmVzLnN5bmNcbiAgICAgICAgICogQHBhcmFtIHBhcmFtcyAgIHRoZSBwYXJhbXMgb2JqZWN0IHBhc3NlZCB0byB0aGUgc3Vic2NyaXB0aW9uLCBleDoge21hZ2F6aW5lSWQ6J2VudHJlcHJlbmV1cid9KVxuICAgICAgICAgKiBAcGFyYW0gb2JqZWN0Q2xhc3MgYW4gaW5zdGFuY2Ugb2YgdGhpcyBjbGFzcyB3aWxsIGJlIGNyZWF0ZWQgZm9yIGVhY2ggcmVjb3JkIHJlY2VpdmVkLlxuICAgICAgICAgKiByZXR1cm5zIGEgcHJvbWlzZSByZXR1cm5pbmcgdGhlIHN1YnNjcmlwdGlvbiB3aGVuIHRoZSBkYXRhIGlzIHN5bmNlZFxuICAgICAgICAgKiBvciByZWplY3RzIGlmIHRoZSBpbml0aWFsIHN5bmMgZmFpbHMgdG8gY29tcGxldGUgaW4gYSBsaW1pdGVkIGFtb3VudCBvZiB0aW1lLiBcbiAgICAgICAgICogXG4gICAgICAgICAqIHRvIGdldCB0aGUgZGF0YSBmcm9tIHRoZSBkYXRhU2V0LCBqdXN0IGRhdGFTZXQuZ2V0RGF0YSgpXG4gICAgICAgICAqL1xuICAgICAgICBmdW5jdGlvbiByZXNvbHZlU3Vic2NyaXB0aW9uKHB1YmxpY2F0aW9uTmFtZSwgcGFyYW1zLCBvYmplY3RDbGFzcykge1xuICAgICAgICAgICAgdmFyIGRlZmVycmVkID0gJHEuZGVmZXIoKTtcbiAgICAgICAgICAgIHZhciBzRHMgPSBzdWJzY3JpYmUocHVibGljYXRpb25OYW1lKS5zZXRPYmplY3RDbGFzcyhvYmplY3RDbGFzcyk7XG5cbiAgICAgICAgICAgIC8vIGdpdmUgYSBsaXR0bGUgdGltZSBmb3Igc3Vic2NyaXB0aW9uIHRvIGZldGNoIHRoZSBkYXRhLi4ub3RoZXJ3aXNlIGdpdmUgdXAgc28gdGhhdCB3ZSBkb24ndCBnZXQgc3R1Y2sgaW4gYSByZXNvbHZlIHdhaXRpbmcgZm9yZXZlci5cbiAgICAgICAgICAgIHZhciBncmFjZVBlcmlvZCA9IHNldFRpbWVvdXQoZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgIGlmICghc0RzLnJlYWR5KSB7XG4gICAgICAgICAgICAgICAgICAgIHNEcy5kZXN0cm95KCk7XG4gICAgICAgICAgICAgICAgICAgIGxvZ0luZm8oJ0F0dGVtcHQgdG8gc3Vic2NyaWJlIHRvIHB1YmxpY2F0aW9uICcgKyBwdWJsaWNhdGlvbk5hbWUgKyAnIGZhaWxlZCcpO1xuICAgICAgICAgICAgICAgICAgICBkZWZlcnJlZC5yZWplY3QoJ1NZTkNfVElNRU9VVCcpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0sIEdSQUNFX1BFUklPRF9JTl9TRUNPTkRTICogMTAwMCk7XG5cbiAgICAgICAgICAgIHNEcy5zZXRQYXJhbWV0ZXJzKHBhcmFtcylcbiAgICAgICAgICAgICAgICAud2FpdEZvckRhdGFSZWFkeSgpXG4gICAgICAgICAgICAgICAgLnRoZW4oZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgICAgICBjbGVhclRpbWVvdXQoZ3JhY2VQZXJpb2QpO1xuICAgICAgICAgICAgICAgICAgICBkZWZlcnJlZC5yZXNvbHZlKHNEcyk7XG4gICAgICAgICAgICAgICAgfSkuY2F0Y2goZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgICAgICBjbGVhclRpbWVvdXQoZ3JhY2VQZXJpb2QpO1xuICAgICAgICAgICAgICAgICAgICBzRHMuZGVzdHJveSgpO1xuICAgICAgICAgICAgICAgICAgICBkZWZlcnJlZC5yZWplY3QoJ0ZhaWxlZCB0byBzdWJzY3JpYmUgdG8gcHVibGljYXRpb24gJyArIHB1YmxpY2F0aW9uTmFtZSArICcgZmFpbGVkJyk7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICByZXR1cm4gZGVmZXJyZWQucHJvbWlzZTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiBcbiAgICAgICAgICogZm9yIHRlc3QgcHVycG9zZXMsIHJldHVybnMgdGhlIHRpbWUgcmVzb2x2ZVN1YnNjcmlwdGlvbiBiZWZvcmUgaXQgdGltZXMgb3V0LlxuICAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gZ2V0R3JhY2VQZXJpb2QoKSB7XG4gICAgICAgICAgICByZXR1cm4gR1JBQ0VfUEVSSU9EX0lOX1NFQ09ORFM7XG4gICAgICAgIH1cbiAgICAgICAgLyoqXG4gICAgICAgICAqIHN1YnNjcmliZSB0byBwdWJsaWNhdGlvbi4gSXQgd2lsbCBub3Qgc3luYyB1bnRpbCB5b3Ugc2V0IHRoZSBwYXJhbXMuXG4gICAgICAgICAqIFxuICAgICAgICAgKiBAcGFyYW0gcHVibGljYXRpb24gbmFtZS4gb24gdGhlIHNlcnZlciBzaWRlLCBhIHB1YmxpY2F0aW9uIHNoYWxsIGV4aXN0LiBleDogbWFnYXppbmVzLnN5bmNcbiAgICAgICAgICogQHBhcmFtIHBhcmFtcyAgIHRoZSBwYXJhbXMgb2JqZWN0IHBhc3NlZCB0byB0aGUgc3Vic2NyaXB0aW9uLCBleDoge21hZ2F6aW5lSWQ6J2VudHJlcHJlbmV1cid9KVxuICAgICAgICAgKiByZXR1cm5zIHN1YnNjcmlwdGlvblxuICAgICAgICAgKiBcbiAgICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIHN1YnNjcmliZShwdWJsaWNhdGlvbk5hbWUsIHNjb3BlKSB7XG4gICAgICAgICAgICByZXR1cm4gbmV3IFN1YnNjcmlwdGlvbihwdWJsaWNhdGlvbk5hbWUsIHNjb3BlKTtcbiAgICAgICAgfVxuXG5cblxuICAgICAgICAvLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vL1xuICAgICAgICAvLyBIRUxQRVJTXG5cbiAgICAgICAgLy8gZXZlcnkgc3luYyBub3RpZmljYXRpb24gY29tZXMgdGhydSB0aGUgc2FtZSBldmVudCB0aGVuIGl0IGlzIGRpc3BhdGNoZXMgdG8gdGhlIHRhcmdldGVkIHN1YnNjcmlwdGlvbnMuXG4gICAgICAgIGZ1bmN0aW9uIGxpc3RlblRvU3luY05vdGlmaWNhdGlvbigpIHtcbiAgICAgICAgICAgICRzb2NrZXRpby5vbignU1lOQ19OT1cnLCBmdW5jdGlvbiAoc3ViTm90aWZpY2F0aW9uLCBmbikge1xuICAgICAgICAgICAgICAgIGxvZ0luZm8oJ1N5bmNpbmcgd2l0aCBzdWJzY3JpcHRpb24gW25hbWU6JyArIHN1Yk5vdGlmaWNhdGlvbi5uYW1lICsgJywgaWQ6JyArIHN1Yk5vdGlmaWNhdGlvbi5zdWJzY3JpcHRpb25JZCArICcgLCBwYXJhbXM6JyArIEpTT04uc3RyaW5naWZ5KHN1Yk5vdGlmaWNhdGlvbi5wYXJhbXMpICsgJ10uIFJlY29yZHM6JyArIHN1Yk5vdGlmaWNhdGlvbi5yZWNvcmRzLmxlbmd0aCArICdbJyArIChzdWJOb3RpZmljYXRpb24uZGlmZiA/ICdEaWZmJyA6ICdBbGwnKSArICddJyk7XG4gICAgICAgICAgICAgICAgdmFyIGxpc3RlbmVycyA9IHB1YmxpY2F0aW9uTGlzdGVuZXJzW3N1Yk5vdGlmaWNhdGlvbi5uYW1lXTtcbiAgICAgICAgICAgICAgICBpZiAobGlzdGVuZXJzKSB7XG4gICAgICAgICAgICAgICAgICAgIGZvciAodmFyIGxpc3RlbmVyIGluIGxpc3RlbmVycykge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGlzdGVuZXJzW2xpc3RlbmVyXShzdWJOb3RpZmljYXRpb24pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGZuKCdTWU5DRUQnKTsgLy8gbGV0IGtub3cgdGhlIGJhY2tlbmQgdGhlIGNsaWVudCB3YXMgYWJsZSB0byBzeW5jLlxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH07XG5cblxuICAgICAgICAvLyB0aGlzIGFsbG93cyBhIGRhdGFzZXQgdG8gbGlzdGVuIHRvIGFueSBTWU5DX05PVyBldmVudC4uYW5kIGlmIHRoZSBub3RpZmljYXRpb24gaXMgYWJvdXQgaXRzIGRhdGEuXG4gICAgICAgIGZ1bmN0aW9uIGFkZFB1YmxpY2F0aW9uTGlzdGVuZXIoc3RyZWFtTmFtZSwgY2FsbGJhY2spIHtcbiAgICAgICAgICAgIHZhciB1aWQgPSBwdWJsaWNhdGlvbkxpc3RlbmVyQ291bnQrKztcbiAgICAgICAgICAgIHZhciBsaXN0ZW5lcnMgPSBwdWJsaWNhdGlvbkxpc3RlbmVyc1tzdHJlYW1OYW1lXTtcbiAgICAgICAgICAgIGlmICghbGlzdGVuZXJzKSB7XG4gICAgICAgICAgICAgICAgcHVibGljYXRpb25MaXN0ZW5lcnNbc3RyZWFtTmFtZV0gPSBsaXN0ZW5lcnMgPSB7fTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGxpc3RlbmVyc1t1aWRdID0gY2FsbGJhY2s7XG5cbiAgICAgICAgICAgIHJldHVybiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgZGVsZXRlIGxpc3RlbmVyc1t1aWRdO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgICAgICAvLyBTdWJzY3JpcHRpb24gb2JqZWN0XG4gICAgICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgICAgICAvKipcbiAgICAgICAgICogYSBzdWJzY3JpcHRpb24gc3luY2hyb25pemVzIHdpdGggdGhlIGJhY2tlbmQgZm9yIGFueSBiYWNrZW5kIGRhdGEgY2hhbmdlIGFuZCBtYWtlcyB0aGF0IGRhdGEgYXZhaWxhYmxlIHRvIGEgY29udHJvbGxlci5cbiAgICAgICAgICogXG4gICAgICAgICAqICBXaGVuIGNsaWVudCBzdWJzY3JpYmVzIHRvIGFuIHN5bmNyb25pemVkIGFwaSwgYW55IGRhdGEgY2hhbmdlIHRoYXQgaW1wYWN0cyB0aGUgYXBpIHJlc3VsdCBXSUxMIGJlIFBVU0hlZCB0byB0aGUgY2xpZW50LlxuICAgICAgICAgKiBJZiB0aGUgY2xpZW50IGRvZXMgTk9UIHN1YnNjcmliZSBvciBzdG9wIHN1YnNjcmliZSwgaXQgd2lsbCBubyBsb25nZXIgcmVjZWl2ZSB0aGUgUFVTSC4gXG4gICAgICAgICAqICAgIFxuICAgICAgICAgKiBpZiB0aGUgY29ubmVjdGlvbiBpcyBsb3N0IGZvciBhIHNob3J0IHRpbWUgKGR1cmF0aW9uIGRlZmluZWQgb24gc2VydmVyLXNpZGUpLCB0aGUgc2VydmVyIHF1ZXVlcyB0aGUgY2hhbmdlcyBpZiBhbnkuIFxuICAgICAgICAgKiBXaGVuIHRoZSBjb25uZWN0aW9uIHJldHVybnMsIHRoZSBtaXNzaW5nIGRhdGEgYXV0b21hdGljYWxseSAgd2lsbCBiZSBQVVNIZWQgdG8gdGhlIHN1YnNjcmliaW5nIGNsaWVudC5cbiAgICAgICAgICogaWYgdGhlIGNvbm5lY3Rpb24gaXMgbG9zdCBmb3IgYSBsb25nIHRpbWUgKGR1cmF0aW9uIGRlZmluZWQgb24gdGhlIHNlcnZlciksIHRoZSBzZXJ2ZXIgd2lsbCBkZXN0cm95IHRoZSBzdWJzY3JpcHRpb24uIFRvIHNpbXBsaWZ5LCB0aGUgY2xpZW50IHdpbGwgcmVzdWJzY3JpYmUgYXQgaXRzIHJlY29ubmVjdGlvbiBhbmQgZ2V0IGFsbCBkYXRhLlxuICAgICAgICAgKiBcbiAgICAgICAgICogc3Vic2NyaXB0aW9uIG9iamVjdCBwcm92aWRlcyAzIGNhbGxiYWNrcyAoYWRkLHVwZGF0ZSwgZGVsKSB3aGljaCBhcmUgY2FsbGVkIGR1cmluZyBzeW5jaHJvbml6YXRpb24uXG4gICAgICAgICAqICAgICAgXG4gICAgICAgICAqIFNjb3BlIHdpbGwgYWxsb3cgdGhlIHN1YnNjcmlwdGlvbiBzdG9wIHN5bmNocm9uaXppbmcgYW5kIGNhbmNlbCByZWdpc3RyYXRpb24gd2hlbiBpdCBpcyBkZXN0cm95ZWQuIFxuICAgICAgICAgKiAgXG4gICAgICAgICAqIENvbnN0cnVjdG9yOlxuICAgICAgICAgKiBcbiAgICAgICAgICogQHBhcmFtIHB1YmxpY2F0aW9uLCB0aGUgcHVibGljYXRpb24gbXVzdCBleGlzdCBvbiB0aGUgc2VydmVyIHNpZGVcbiAgICAgICAgICogQHBhcmFtIHNjb3BlLCBieSBkZWZhdWx0ICRyb290U2NvcGUsIGJ1dCBjYW4gYmUgbW9kaWZpZWQgbGF0ZXIgb24gd2l0aCBhdHRhY2ggbWV0aG9kLlxuICAgICAgICAgKi9cblxuICAgICAgICBmdW5jdGlvbiBTdWJzY3JpcHRpb24ocHVibGljYXRpb24sIHNjb3BlKSB7XG4gICAgICAgICAgICB2YXIgdGltZXN0YW1wRmllbGQsIGlzU3luY2luZ09uID0gZmFsc2UsIGlzU2luZ2xlLCB1cGRhdGVEYXRhU3RvcmFnZSwgY2FjaGUsIGlzSW5pdGlhbFB1c2hDb21wbGV0ZWQsIGRlZmVycmVkSW5pdGlhbGl6YXRpb24sIHN0cmljdE1vZGU7XG4gICAgICAgICAgICB2YXIgb25SZWFkeU9mZiwgZm9ybWF0UmVjb3JkO1xuICAgICAgICAgICAgdmFyIHJlY29ubmVjdE9mZiwgcHVibGljYXRpb25MaXN0ZW5lck9mZiwgZGVzdHJveU9mZjtcbiAgICAgICAgICAgIHZhciBvYmplY3RDbGFzcztcbiAgICAgICAgICAgIHZhciBzdWJzY3JpcHRpb25JZDtcblxuICAgICAgICAgICAgdmFyIHNEcyA9IHRoaXM7XG4gICAgICAgICAgICB2YXIgc3ViUGFyYW1zID0ge307XG4gICAgICAgICAgICB2YXIgcmVjb3JkU3RhdGVzID0ge307XG4gICAgICAgICAgICB2YXIgaW5uZXJTY29wZTsvLz0gJHJvb3RTY29wZS4kbmV3KHRydWUpO1xuICAgICAgICAgICAgdmFyIHN5bmNMaXN0ZW5lciA9IG5ldyBTeW5jTGlzdGVuZXIoKTtcblxuXG4gICAgICAgICAgICB0aGlzLnJlYWR5ID0gZmFsc2U7XG4gICAgICAgICAgICB0aGlzLnN5bmNPbiA9IHN5bmNPbjtcbiAgICAgICAgICAgIHRoaXMuc3luY09mZiA9IHN5bmNPZmY7XG4gICAgICAgICAgICB0aGlzLnNldE9uUmVhZHkgPSBzZXRPblJlYWR5O1xuXG4gICAgICAgICAgICB0aGlzLm9uUmVhZHkgPSBvblJlYWR5O1xuICAgICAgICAgICAgdGhpcy5vblVwZGF0ZSA9IG9uVXBkYXRlO1xuICAgICAgICAgICAgdGhpcy5vbkFkZCA9IG9uQWRkO1xuICAgICAgICAgICAgdGhpcy5vblJlbW92ZSA9IG9uUmVtb3ZlO1xuXG4gICAgICAgICAgICB0aGlzLmdldERhdGEgPSBnZXREYXRhO1xuICAgICAgICAgICAgdGhpcy5zZXRQYXJhbWV0ZXJzID0gc2V0UGFyYW1ldGVycztcblxuICAgICAgICAgICAgdGhpcy53YWl0Rm9yRGF0YVJlYWR5ID0gd2FpdEZvckRhdGFSZWFkeTtcbiAgICAgICAgICAgIHRoaXMud2FpdEZvclN1YnNjcmlwdGlvblJlYWR5ID0gd2FpdEZvclN1YnNjcmlwdGlvblJlYWR5O1xuXG4gICAgICAgICAgICB0aGlzLnNldEZvcmNlID0gc2V0Rm9yY2U7XG4gICAgICAgICAgICB0aGlzLmlzU3luY2luZyA9IGlzU3luY2luZztcbiAgICAgICAgICAgIHRoaXMuaXNSZWFkeSA9IGlzUmVhZHk7XG5cbiAgICAgICAgICAgIHRoaXMuc2V0U2luZ2xlID0gc2V0U2luZ2xlO1xuXG4gICAgICAgICAgICB0aGlzLnNldE9iamVjdENsYXNzID0gc2V0T2JqZWN0Q2xhc3M7XG4gICAgICAgICAgICB0aGlzLmdldE9iamVjdENsYXNzID0gZ2V0T2JqZWN0Q2xhc3M7XG5cbiAgICAgICAgICAgIHRoaXMuc2V0U3RyaWN0TW9kZSA9IHNldFN0cmljdE1vZGU7XG5cbiAgICAgICAgICAgIHRoaXMuYXR0YWNoID0gYXR0YWNoO1xuICAgICAgICAgICAgdGhpcy5kZXN0cm95ID0gZGVzdHJveTtcblxuICAgICAgICAgICAgdGhpcy5pc0V4aXN0aW5nU3RhdGVGb3IgPSBpc0V4aXN0aW5nU3RhdGVGb3I7IC8vIGZvciB0ZXN0aW5nIHB1cnBvc2VzXG5cbiAgICAgICAgICAgIHNldFNpbmdsZShmYWxzZSk7XG5cbiAgICAgICAgICAgIC8vIHRoaXMgd2lsbCBtYWtlIHN1cmUgdGhhdCB0aGUgc3Vic2NyaXB0aW9uIGlzIHJlbGVhc2VkIGZyb20gc2VydmVycyBpZiB0aGUgYXBwIGNsb3NlcyAoY2xvc2UgYnJvd3NlciwgcmVmcmVzaC4uLilcbiAgICAgICAgICAgIGF0dGFjaChzY29wZSB8fCAkcm9vdFNjb3BlKTtcblxuICAgICAgICAgICAgLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vL1xuXG4gICAgICAgICAgICBmdW5jdGlvbiBkZXN0cm95KCkge1xuICAgICAgICAgICAgICAgIHN5bmNPZmYoKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLyoqIHRoaXMgd2lsbCBiZSBjYWxsZWQgd2hlbiBkYXRhIGlzIGF2YWlsYWJsZSBcbiAgICAgICAgICAgICAqICBpdCBtZWFucyByaWdodCBhZnRlciBlYWNoIHN5bmMhXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICAqIFxuICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIHNldE9uUmVhZHkoY2FsbGJhY2spIHtcbiAgICAgICAgICAgICAgICBpZiAob25SZWFkeU9mZikge1xuICAgICAgICAgICAgICAgICAgICBvblJlYWR5T2ZmKCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIG9uUmVhZHlPZmYgPSBvblJlYWR5KGNhbGxiYWNrKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqIGZvcmNlIHJlc3luY2luZyBmcm9tIHNjcmF0Y2ggZXZlbiBpZiB0aGUgcGFyYW1ldGVycyBoYXZlIG5vdCBjaGFuZ2VkXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICAqIGlmIG91dHNpZGUgY29kZSBoYXMgbW9kaWZpZWQgdGhlIGRhdGEgYW5kIHlvdSBuZWVkIHRvIHJvbGxiYWNrLCB5b3UgY291bGQgY29uc2lkZXIgZm9yY2luZyBhIHJlZnJlc2ggd2l0aCB0aGlzLiBCZXR0ZXIgc29sdXRpb24gc2hvdWxkIGJlIGZvdW5kIHRoYW4gdGhhdC5cbiAgICAgICAgICAgICAqIFxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBzZXRGb3JjZSh2YWx1ZSkge1xuICAgICAgICAgICAgICAgIGlmICh2YWx1ZSkge1xuICAgICAgICAgICAgICAgICAgICAvLyBxdWljayBoYWNrIHRvIGZvcmNlIHRvIHJlbG9hZC4uLnJlY29kZSBsYXRlci5cbiAgICAgICAgICAgICAgICAgICAgc0RzLnN5bmNPZmYoKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgKiBpZiBzZXQgdG8gdHJ1ZSwgaWYgYW4gb2JqZWN0IHdpdGhpbiBhbiBhcnJheSBwcm9wZXJ0eSBvZiB0aGUgcmVjb3JkIHRvIHN5bmMgaGFzIG5vIElEIGZpZWxkLlxuICAgICAgICAgICAgICogYW4gZXJyb3Igd291bGQgYmUgdGhyb3duLlxuICAgICAgICAgICAgICogSXQgaXMgaW1wb3J0YW50IGlmIHdlIHdhbnQgdG8gYmUgYWJsZSB0byBtYWludGFpbiBpbnN0YW5jZSByZWZlcmVuY2VzIGV2ZW4gZm9yIHRoZSBvYmplY3RzIGluc2lkZSBhcnJheXMuXG4gICAgICAgICAgICAgKlxuICAgICAgICAgICAgICogRm9yY2VzIHVzIHRvIHVzZSBpZCBldmVyeSB3aGVyZS5cbiAgICAgICAgICAgICAqXG4gICAgICAgICAgICAgKiBTaG91bGQgYmUgdGhlIGRlZmF1bHQuLi5idXQgdG9vIHJlc3RyaWN0aXZlIGZvciBub3cuXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIHNldFN0cmljdE1vZGUodmFsdWUpIHtcbiAgICAgICAgICAgICAgICBzdHJpY3RNb2RlID0gdmFsdWU7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgKiBUaGUgZm9sbG93aW5nIG9iamVjdCB3aWxsIGJlIGJ1aWx0IHVwb24gZWFjaCByZWNvcmQgcmVjZWl2ZWQgZnJvbSB0aGUgYmFja2VuZFxuICAgICAgICAgICAgICogXG4gICAgICAgICAgICAgKiBUaGlzIGNhbm5vdCBiZSBtb2RpZmllZCBhZnRlciB0aGUgc3luYyBoYXMgc3RhcnRlZC5cbiAgICAgICAgICAgICAqIFxuICAgICAgICAgICAgICogQHBhcmFtIGNsYXNzVmFsdWVcbiAgICAgICAgICAgICAqL1xuICAgICAgICAgICAgZnVuY3Rpb24gc2V0T2JqZWN0Q2xhc3MoY2xhc3NWYWx1ZSkge1xuICAgICAgICAgICAgICAgIGlmIChkZWZlcnJlZEluaXRpYWxpemF0aW9uKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgb2JqZWN0Q2xhc3MgPSBjbGFzc1ZhbHVlO1xuICAgICAgICAgICAgICAgIGZvcm1hdFJlY29yZCA9IGZ1bmN0aW9uIChyZWNvcmQpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIG5ldyBvYmplY3RDbGFzcyhyZWNvcmQpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBzZXRTaW5nbGUoaXNTaW5nbGUpO1xuICAgICAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIGdldE9iamVjdENsYXNzKCkge1xuICAgICAgICAgICAgICAgIHJldHVybiBvYmplY3RDbGFzcztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgKiB0aGlzIGZ1bmN0aW9uIHN0YXJ0cyB0aGUgc3luY2luZy5cbiAgICAgICAgICAgICAqIE9ubHkgcHVibGljYXRpb24gcHVzaGluZyBkYXRhIG1hdGNoaW5nIG91ciBmZXRjaGluZyBwYXJhbXMgd2lsbCBiZSByZWNlaXZlZC5cbiAgICAgICAgICAgICAqIFxuICAgICAgICAgICAgICogZXg6IGZvciBhIHB1YmxpY2F0aW9uIG5hbWVkIFwibWFnYXppbmVzLnN5bmNcIiwgaWYgZmV0Y2hpbmcgcGFyYW1zIGVxdWFsbGVkIHttYWdhemluTmFtZTonY2Fycyd9LCB0aGUgbWFnYXppbmUgY2FycyBkYXRhIHdvdWxkIGJlIHJlY2VpdmVkIGJ5IHRoaXMgc3Vic2NyaXB0aW9uLlxuICAgICAgICAgICAgICogXG4gICAgICAgICAgICAgKiBAcGFyYW0gZmV0Y2hpbmdQYXJhbXNcbiAgICAgICAgICAgICAqIEBwYXJhbSBvcHRpb25zXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICAqIEByZXR1cm5zIGEgcHJvbWlzZSB0aGF0IHJlc29sdmVzIHdoZW4gZGF0YSBpcyBhcnJpdmVkLlxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBzZXRQYXJhbWV0ZXJzKGZldGNoaW5nUGFyYW1zLCBvcHRpb25zKSB7XG4gICAgICAgICAgICAgICAgaWYgKGlzU3luY2luZ09uICYmIGFuZ3VsYXIuZXF1YWxzKGZldGNoaW5nUGFyYW1zIHx8IHt9LCBzdWJQYXJhbXMpKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIGlmIHRoZSBwYXJhbXMgaGF2ZSBub3QgY2hhbmdlZCwganVzdCByZXR1cm5zIHdpdGggY3VycmVudCBkYXRhLlxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gc0RzOyAvLyRxLnJlc29sdmUoZ2V0RGF0YSgpKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgc3luY09mZigpO1xuICAgICAgICAgICAgICAgIGlmICghaXNTaW5nbGUpIHtcbiAgICAgICAgICAgICAgICAgICAgY2FjaGUubGVuZ3RoID0gMDtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBzdWJQYXJhbXMgPSBmZXRjaGluZ1BhcmFtcyB8fCB7fTtcbiAgICAgICAgICAgICAgICBvcHRpb25zID0gb3B0aW9ucyB8fCB7fTtcbiAgICAgICAgICAgICAgICBpZiAoYW5ndWxhci5pc0RlZmluZWQob3B0aW9ucy5zaW5nbGUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHNldFNpbmdsZShvcHRpb25zLnNpbmdsZSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHN5bmNPbigpO1xuICAgICAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogQHJldHVybnMgYSBwcm9taXNlIHRoYXQgd2FpdHMgZm9yIHRoZSBpbml0aWFsIGZldGNoIHRvIGNvbXBsZXRlIHRoZW4gd2FpdCBmb3IgdGhlIGluaXRpYWwgZmV0Y2ggdG8gY29tcGxldGUgdGhlbiByZXR1cm5zIHRoaXMgc3Vic2NyaXB0aW9uLlxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiB3YWl0Rm9yU3Vic2NyaXB0aW9uUmVhZHkoKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHN5bmNPbigpLnRoZW4oZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqIEByZXR1cm5zIGEgcHJvbWlzZSB0aGF0IHdhaXRzIGZvciB0aGUgaW5pdGlhbCBmZXRjaCB0byBjb21wbGV0ZSB0aGVuIHJldHVybnMgdGhlIGRhdGFcbiAgICAgICAgICAgICAqL1xuICAgICAgICAgICAgZnVuY3Rpb24gd2FpdEZvckRhdGFSZWFkeSgpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gc3luY09uKCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIGRvZXMgdGhlIGRhdGFzZXQgcmV0dXJucyBvbmx5IG9uZSBvYmplY3Q/IG5vdCBhbiBhcnJheT9cbiAgICAgICAgICAgIGZ1bmN0aW9uIHNldFNpbmdsZSh2YWx1ZSkge1xuICAgICAgICAgICAgICAgIGlmIChkZWZlcnJlZEluaXRpYWxpemF0aW9uKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgdmFyIHVwZGF0ZUZuO1xuICAgICAgICAgICAgICAgIGlzU2luZ2xlID0gdmFsdWU7XG4gICAgICAgICAgICAgICAgaWYgKHZhbHVlKSB7XG4gICAgICAgICAgICAgICAgICAgIHVwZGF0ZUZuID0gdXBkYXRlU3luY2VkT2JqZWN0O1xuICAgICAgICAgICAgICAgICAgICBjYWNoZSA9IG9iamVjdENsYXNzID8gbmV3IG9iamVjdENsYXNzKHt9KSA6IHt9O1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHVwZGF0ZUZuID0gdXBkYXRlU3luY2VkQXJyYXk7XG4gICAgICAgICAgICAgICAgICAgIGNhY2hlID0gW107XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgdXBkYXRlRGF0YVN0b3JhZ2UgPSBmdW5jdGlvbiAocmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB1cGRhdGVGbihyZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBlLm1lc3NhZ2UgPSAnUmVjZWl2ZWQgSW52YWxpZCBvYmplY3QgZnJvbSBwdWJsaWNhdGlvbiBbJyArIHB1YmxpY2F0aW9uICsgJ106ICcgKyBKU09OLnN0cmluZ2lmeShyZWNvcmQpICsgJy4gREVUQUlMUzogJyArIGUubWVzc2FnZTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IGU7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyByZXR1cm5zIHRoZSBvYmplY3Qgb3IgYXJyYXkgaW4gc3luY1xuICAgICAgICAgICAgZnVuY3Rpb24gZ2V0RGF0YSgpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gY2FjaGU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogdGhlIGRhdGFzZXQgd2lsbCBzdGFydCBsaXN0ZW5pbmcgdG8gdGhlIGRhdGFzdHJlYW0gXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICAqIE5vdGUgRHVyaW5nIHRoZSBzeW5jLCBpdCB3aWxsIGFsc28gY2FsbCB0aGUgb3B0aW9uYWwgY2FsbGJhY2tzIC0gYWZ0ZXIgcHJvY2Vzc2luZyBFQUNIIHJlY29yZCByZWNlaXZlZC5cbiAgICAgICAgICAgICAqIFxuICAgICAgICAgICAgICogQHJldHVybnMgYSBwcm9taXNlIHRoYXQgd2lsbCBiZSByZXNvbHZlZCB3aGVuIHRoZSBkYXRhIGlzIHJlYWR5LlxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBzeW5jT24oKSB7XG4gICAgICAgICAgICAgICAgaWYgKGlzU3luY2luZ09uKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBkZWZlcnJlZEluaXRpYWxpemF0aW9uLnByb21pc2U7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGRlZmVycmVkSW5pdGlhbGl6YXRpb24gPSAkcS5kZWZlcigpO1xuICAgICAgICAgICAgICAgIGlzSW5pdGlhbFB1c2hDb21wbGV0ZWQgPSBmYWxzZTtcbiAgICAgICAgICAgICAgICBsb2dJbmZvKCdTeW5jICcgKyBwdWJsaWNhdGlvbiArICcgb24uIFBhcmFtczonICsgSlNPTi5zdHJpbmdpZnkoc3ViUGFyYW1zKSk7XG4gICAgICAgICAgICAgICAgaXNTeW5jaW5nT24gPSB0cnVlO1xuICAgICAgICAgICAgICAgIHJlZ2lzdGVyU3Vic2NyaXB0aW9uKCk7XG4gICAgICAgICAgICAgICAgcmVhZHlGb3JMaXN0ZW5pbmcoKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gZGVmZXJyZWRJbml0aWFsaXphdGlvbi5wcm9taXNlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqIHRoZSBkYXRhc2V0IGlzIG5vIGxvbmdlciBsaXN0ZW5pbmcgYW5kIHdpbGwgbm90IGNhbGwgYW55IGNhbGxiYWNrXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIHN5bmNPZmYoKSB7XG4gICAgICAgICAgICAgICAgaWYgKGRlZmVycmVkSW5pdGlhbGl6YXRpb24pIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gaWYgdGhlcmUgaXMgY29kZSB3YWl0aW5nIG9uIHRoaXMgcHJvbWlzZS4uIGV4IChsb2FkIGluIHJlc29sdmUpXG4gICAgICAgICAgICAgICAgICAgIGRlZmVycmVkSW5pdGlhbGl6YXRpb24ucmVzb2x2ZShnZXREYXRhKCkpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBpZiAoaXNTeW5jaW5nT24pIHtcbiAgICAgICAgICAgICAgICAgICAgdW5yZWdpc3RlclN1YnNjcmlwdGlvbigpO1xuICAgICAgICAgICAgICAgICAgICBpc1N5bmNpbmdPbiA9IGZhbHNlO1xuXG4gICAgICAgICAgICAgICAgICAgIGxvZ0luZm8oJ1N5bmMgJyArIHB1YmxpY2F0aW9uICsgJyBvZmYuIFBhcmFtczonICsgSlNPTi5zdHJpbmdpZnkoc3ViUGFyYW1zKSk7XG4gICAgICAgICAgICAgICAgICAgIGlmIChwdWJsaWNhdGlvbkxpc3RlbmVyT2ZmKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBwdWJsaWNhdGlvbkxpc3RlbmVyT2ZmKCk7XG4gICAgICAgICAgICAgICAgICAgICAgICBwdWJsaWNhdGlvbkxpc3RlbmVyT2ZmID0gbnVsbDtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBpZiAocmVjb25uZWN0T2ZmKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZWNvbm5lY3RPZmYoKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJlY29ubmVjdE9mZiA9IG51bGw7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIGlzU3luY2luZygpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gaXNTeW5jaW5nT247XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIHJlYWR5Rm9yTGlzdGVuaW5nKCkge1xuICAgICAgICAgICAgICAgIGlmICghcHVibGljYXRpb25MaXN0ZW5lck9mZikge1xuICAgICAgICAgICAgICAgICAgICBsaXN0ZW5Gb3JSZWNvbm5lY3Rpb25Ub1Jlc3luYygpO1xuICAgICAgICAgICAgICAgICAgICBsaXN0ZW5Ub1B1YmxpY2F0aW9uKCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqICBCeSBkZWZhdWx0IHRoZSByb290c2NvcGUgaXMgYXR0YWNoZWQgaWYgbm8gc2NvcGUgd2FzIHByb3ZpZGVkLiBCdXQgaXQgaXMgcG9zc2libGUgdG8gcmUtYXR0YWNoIGl0IHRvIGEgZGlmZmVyZW50IHNjb3BlLiBpZiB0aGUgc3Vic2NyaXB0aW9uIGRlcGVuZHMgb24gYSBjb250cm9sbGVyLlxuICAgICAgICAgICAgICpcbiAgICAgICAgICAgICAqICBEbyBub3QgYXR0YWNoIGFmdGVyIGl0IGhhcyBzeW5jZWQuXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIGF0dGFjaChuZXdTY29wZSkge1xuICAgICAgICAgICAgICAgIGlmIChkZWZlcnJlZEluaXRpYWxpemF0aW9uKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGlmIChkZXN0cm95T2ZmKSB7XG4gICAgICAgICAgICAgICAgICAgIGRlc3Ryb3lPZmYoKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgaW5uZXJTY29wZSA9IG5ld1Njb3BlO1xuICAgICAgICAgICAgICAgIGRlc3Ryb3lPZmYgPSBpbm5lclNjb3BlLiRvbignJGRlc3Ryb3knLCBkZXN0cm95KTtcblxuICAgICAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIGxpc3RlbkZvclJlY29ubmVjdGlvblRvUmVzeW5jKGxpc3Rlbk5vdykge1xuICAgICAgICAgICAgICAgIC8vIGdpdmUgYSBjaGFuY2UgdG8gY29ubmVjdCBiZWZvcmUgbGlzdGVuaW5nIHRvIHJlY29ubmVjdGlvbi4uLiBAVE9ETyBzaG91bGQgaGF2ZSB1c2VyX3JlY29ubmVjdGVkX2V2ZW50XG4gICAgICAgICAgICAgICAgc2V0VGltZW91dChmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgICAgIHJlY29ubmVjdE9mZiA9IGlubmVyU2NvcGUuJG9uKCd1c2VyX2Nvbm5lY3RlZCcsIGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxvZ0RlYnVnKCdSZXN5bmNpbmcgYWZ0ZXIgbmV0d29yayBsb3NzIHRvICcgKyBwdWJsaWNhdGlvbik7XG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBub3RlIHRoZSBiYWNrZW5kIG1pZ2h0IHJldHVybiBhIG5ldyBzdWJzY3JpcHRpb24gaWYgdGhlIGNsaWVudCB0b29rIHRvbyBtdWNoIHRpbWUgdG8gcmVjb25uZWN0LlxuICAgICAgICAgICAgICAgICAgICAgICAgcmVnaXN0ZXJTdWJzY3JpcHRpb24oKTtcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfSwgbGlzdGVuTm93ID8gMCA6IDIwMDApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiByZWdpc3RlclN1YnNjcmlwdGlvbigpIHtcbiAgICAgICAgICAgICAgICAkc29ja2V0aW8uZmV0Y2goJ3N5bmMuc3Vic2NyaWJlJywge1xuICAgICAgICAgICAgICAgICAgICB2ZXJzaW9uOiBTWU5DX1ZFUlNJT04sXG4gICAgICAgICAgICAgICAgICAgIGlkOiBzdWJzY3JpcHRpb25JZCwgLy8gdG8gdHJ5IHRvIHJlLXVzZSBleGlzdGluZyBzdWJjcmlwdGlvblxuICAgICAgICAgICAgICAgICAgICBwdWJsaWNhdGlvbjogcHVibGljYXRpb24sXG4gICAgICAgICAgICAgICAgICAgIHBhcmFtczogc3ViUGFyYW1zXG4gICAgICAgICAgICAgICAgfSkudGhlbihmdW5jdGlvbiAoc3ViSWQpIHtcbiAgICAgICAgICAgICAgICAgICAgc3Vic2NyaXB0aW9uSWQgPSBzdWJJZDtcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gdW5yZWdpc3RlclN1YnNjcmlwdGlvbigpIHtcbiAgICAgICAgICAgICAgICBpZiAoc3Vic2NyaXB0aW9uSWQpIHtcbiAgICAgICAgICAgICAgICAgICAgJHNvY2tldGlvLmZldGNoKCdzeW5jLnVuc3Vic2NyaWJlJywge1xuICAgICAgICAgICAgICAgICAgICAgICAgdmVyc2lvbjogU1lOQ19WRVJTSU9OLFxuICAgICAgICAgICAgICAgICAgICAgICAgaWQ6IHN1YnNjcmlwdGlvbklkXG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICBzdWJzY3JpcHRpb25JZCA9IG51bGw7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBsaXN0ZW5Ub1B1YmxpY2F0aW9uKCkge1xuICAgICAgICAgICAgICAgIC8vIGNhbm5vdCBvbmx5IGxpc3RlbiB0byBzdWJzY3JpcHRpb25JZCB5ZXQuLi5iZWNhdXNlIHRoZSByZWdpc3RyYXRpb24gbWlnaHQgaGF2ZSBhbnN3ZXIgcHJvdmlkZWQgaXRzIGlkIHlldC4uLmJ1dCBzdGFydGVkIGJyb2FkY2FzdGluZyBjaGFuZ2VzLi4uQFRPRE8gY2FuIGJlIGltcHJvdmVkLi4uXG4gICAgICAgICAgICAgICAgcHVibGljYXRpb25MaXN0ZW5lck9mZiA9IGFkZFB1YmxpY2F0aW9uTGlzdGVuZXIocHVibGljYXRpb24sIGZ1bmN0aW9uIChiYXRjaCkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoc3Vic2NyaXB0aW9uSWQgPT09IGJhdGNoLnN1YnNjcmlwdGlvbklkIHx8ICghc3Vic2NyaXB0aW9uSWQgJiYgY2hlY2tEYXRhU2V0UGFyYW1zSWZNYXRjaGluZ0JhdGNoUGFyYW1zKGJhdGNoLnBhcmFtcykpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWJhdGNoLmRpZmYpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAvLyBDbGVhciB0aGUgY2FjaGUgdG8gcmVidWlsZCBpdCBpZiBhbGwgZGF0YSB3YXMgcmVjZWl2ZWQuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVjb3JkU3RhdGVzID0ge307XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFpc1NpbmdsZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYWNoZS5sZW5ndGggPSAwO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIGFwcGx5Q2hhbmdlcyhiYXRjaC5yZWNvcmRzKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghaXNJbml0aWFsUHVzaENvbXBsZXRlZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlzSW5pdGlhbFB1c2hDb21wbGV0ZWQgPSB0cnVlO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRlZmVycmVkSW5pdGlhbGl6YXRpb24ucmVzb2x2ZShnZXREYXRhKCkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgKiBpZiB0aGUgcGFyYW1zIG9mIHRoZSBkYXRhc2V0IG1hdGNoZXMgdGhlIG5vdGlmaWNhdGlvbiwgaXQgbWVhbnMgdGhlIGRhdGEgbmVlZHMgdG8gYmUgY29sbGVjdCB0byB1cGRhdGUgYXJyYXkuXG4gICAgICAgICAgICAqL1xuICAgICAgICAgICAgZnVuY3Rpb24gY2hlY2tEYXRhU2V0UGFyYW1zSWZNYXRjaGluZ0JhdGNoUGFyYW1zKGJhdGNoUGFyYW1zKSB7XG4gICAgICAgICAgICAgICAgLy8gaWYgKHBhcmFtcy5sZW5ndGggIT0gc3RyZWFtUGFyYW1zLmxlbmd0aCkge1xuICAgICAgICAgICAgICAgIC8vICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICAgICAgLy8gfVxuICAgICAgICAgICAgICAgIGlmICghc3ViUGFyYW1zIHx8IE9iamVjdC5rZXlzKHN1YlBhcmFtcykubGVuZ3RoID09IDApIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRydWVcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgdmFyIG1hdGNoaW5nID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICBmb3IgKHZhciBwYXJhbSBpbiBiYXRjaFBhcmFtcykge1xuICAgICAgICAgICAgICAgICAgICAvLyBhcmUgb3RoZXIgcGFyYW1zIG1hdGNoaW5nP1xuICAgICAgICAgICAgICAgICAgICAvLyBleDogd2UgbWlnaHQgaGF2ZSByZWNlaXZlIGEgbm90aWZpY2F0aW9uIGFib3V0IHRhc2tJZD0yMCBidXQgdGhpcyBzdWJzY3JpcHRpb24gYXJlIG9ubHkgaW50ZXJlc3RlZCBhYm91dCB0YXNrSWQtM1xuICAgICAgICAgICAgICAgICAgICBpZiAoYmF0Y2hQYXJhbXNbcGFyYW1dICE9PSBzdWJQYXJhbXNbcGFyYW1dKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBtYXRjaGluZyA9IGZhbHNlO1xuICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgcmV0dXJuIG1hdGNoaW5nO1xuXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIGZldGNoIGFsbCB0aGUgbWlzc2luZyByZWNvcmRzLCBhbmQgYWN0aXZhdGUgdGhlIGNhbGwgYmFja3MgKGFkZCx1cGRhdGUscmVtb3ZlKSBhY2NvcmRpbmdseSBpZiB0aGVyZSBpcyBzb21ldGhpbmcgdGhhdCBpcyBuZXcgb3Igbm90IGFscmVhZHkgaW4gc3luYy5cbiAgICAgICAgICAgIGZ1bmN0aW9uIGFwcGx5Q2hhbmdlcyhyZWNvcmRzKSB7XG4gICAgICAgICAgICAgICAgdmFyIG5ld0RhdGFBcnJheSA9IFtdO1xuICAgICAgICAgICAgICAgIHZhciBuZXdEYXRhO1xuICAgICAgICAgICAgICAgIHNEcy5yZWFkeSA9IGZhbHNlO1xuICAgICAgICAgICAgICAgIHJlY29yZHMuZm9yRWFjaChmdW5jdGlvbiAocmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vICAgICAgICAgICAgICAgICAgIGxvZ0luZm8oJ0RhdGFzeW5jIFsnICsgZGF0YVN0cmVhbU5hbWUgKyAnXSByZWNlaXZlZDonICtKU09OLnN0cmluZ2lmeShyZWNvcmQpKTsvLysgSlNPTi5zdHJpbmdpZnkocmVjb3JkLmlkKSk7XG4gICAgICAgICAgICAgICAgICAgIGlmIChyZWNvcmQucmVtb3ZlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZW1vdmVSZWNvcmQocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIGlmIChnZXRSZWNvcmRTdGF0ZShyZWNvcmQpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBpZiB0aGUgcmVjb3JkIGlzIGFscmVhZHkgcHJlc2VudCBpbiB0aGUgY2FjaGUuLi5zbyBpdCBpcyBtaWdodGJlIGFuIHVwZGF0ZS4uXG4gICAgICAgICAgICAgICAgICAgICAgICBuZXdEYXRhID0gdXBkYXRlUmVjb3JkKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBuZXdEYXRhID0gYWRkUmVjb3JkKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgaWYgKG5ld0RhdGEpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIG5ld0RhdGFBcnJheS5wdXNoKG5ld0RhdGEpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgc0RzLnJlYWR5ID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICBpZiAoaXNTaW5nbGUpIHtcbiAgICAgICAgICAgICAgICAgICAgc3luY0xpc3RlbmVyLm5vdGlmeSgncmVhZHknLCBnZXREYXRhKCkpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHN5bmNMaXN0ZW5lci5ub3RpZnkoJ3JlYWR5JywgZ2V0RGF0YSgpLCBuZXdEYXRhQXJyYXkpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgKiBBbHRob3VnaCBtb3N0IGNhc2VzIGFyZSBoYW5kbGVkIHVzaW5nIG9uUmVhZHksIHRoaXMgdGVsbHMgeW91IHRoZSBjdXJyZW50IGRhdGEgc3RhdGUuXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICAqIEByZXR1cm5zIGlmIHRydWUgaXMgYSBzeW5jIGhhcyBiZWVuIHByb2Nlc3NlZCBvdGhlcndpc2UgZmFsc2UgaWYgdGhlIGRhdGEgaXMgbm90IHJlYWR5LlxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBpc1JlYWR5KCkge1xuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLnJlYWR5O1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICAqIHJldHVybnMgYSBmdW5jdGlvbiB0byByZW1vdmUgdGhlIGxpc3RlbmVyLlxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBvbkFkZChjYWxsYmFjaykge1xuICAgICAgICAgICAgICAgIHJldHVybiBzeW5jTGlzdGVuZXIub24oJ2FkZCcsIGNhbGxiYWNrKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICAqIHJldHVybnMgYSBmdW5jdGlvbiB0byByZW1vdmUgdGhlIGxpc3RlbmVyLlxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBvblVwZGF0ZShjYWxsYmFjaykge1xuICAgICAgICAgICAgICAgIHJldHVybiBzeW5jTGlzdGVuZXIub24oJ3VwZGF0ZScsIGNhbGxiYWNrKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICAqIHJldHVybnMgYSBmdW5jdGlvbiB0byByZW1vdmUgdGhlIGxpc3RlbmVyLlxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBvblJlbW92ZShjYWxsYmFjaykge1xuICAgICAgICAgICAgICAgIHJldHVybiBzeW5jTGlzdGVuZXIub24oJ3JlbW92ZScsIGNhbGxiYWNrKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICAqIHJldHVybnMgYSBmdW5jdGlvbiB0byByZW1vdmUgdGhlIGxpc3RlbmVyLlxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBvblJlYWR5KGNhbGxiYWNrKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHN5bmNMaXN0ZW5lci5vbigncmVhZHknLCBjYWxsYmFjayk7XG4gICAgICAgICAgICB9XG5cblxuICAgICAgICAgICAgZnVuY3Rpb24gYWRkUmVjb3JkKHJlY29yZCkge1xuICAgICAgICAgICAgICAgIGxvZ0RlYnVnKCdTeW5jIC0+IEluc2VydGVkIE5ldyByZWNvcmQgIycgKyBKU09OLnN0cmluZ2lmeShyZWNvcmQuaWQpICsgJyBmb3Igc3Vic2NyaXB0aW9uIHRvICcgKyBwdWJsaWNhdGlvbik7Ly8gSlNPTi5zdHJpbmdpZnkocmVjb3JkKSk7XG4gICAgICAgICAgICAgICAgZ2V0UmV2aXNpb24ocmVjb3JkKTsgLy8ganVzdCBtYWtlIHN1cmUgd2UgY2FuIGdldCBhIHJldmlzaW9uIGJlZm9yZSB3ZSBoYW5kbGUgdGhpcyByZWNvcmRcbiAgICAgICAgICAgICAgICB1cGRhdGVEYXRhU3RvcmFnZShmb3JtYXRSZWNvcmQgPyBmb3JtYXRSZWNvcmQocmVjb3JkKSA6IHJlY29yZCk7XG4gICAgICAgICAgICAgICAgc3luY0xpc3RlbmVyLm5vdGlmeSgnYWRkJywgcmVjb3JkKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gcmVjb3JkO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiB1cGRhdGVSZWNvcmQocmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgdmFyIHByZXZpb3VzID0gZ2V0UmVjb3JkU3RhdGUocmVjb3JkKTtcbiAgICAgICAgICAgICAgICBpZiAoZ2V0UmV2aXNpb24ocmVjb3JkKSA8PSBnZXRSZXZpc2lvbihwcmV2aW91cykpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGxvZ0RlYnVnKCdTeW5jIC0+IFVwZGF0ZWQgcmVjb3JkICMnICsgSlNPTi5zdHJpbmdpZnkocmVjb3JkLmlkKSArICcgZm9yIHN1YnNjcmlwdGlvbiB0byAnICsgcHVibGljYXRpb24pOy8vIEpTT04uc3RyaW5naWZ5KHJlY29yZCkpO1xuICAgICAgICAgICAgICAgIHVwZGF0ZURhdGFTdG9yYWdlKGZvcm1hdFJlY29yZCA/IGZvcm1hdFJlY29yZChyZWNvcmQpIDogcmVjb3JkKTtcbiAgICAgICAgICAgICAgICBzeW5jTGlzdGVuZXIubm90aWZ5KCd1cGRhdGUnLCByZWNvcmQpO1xuICAgICAgICAgICAgICAgIHJldHVybiByZWNvcmQ7XG4gICAgICAgICAgICB9XG5cblxuICAgICAgICAgICAgZnVuY3Rpb24gcmVtb3ZlUmVjb3JkKHJlY29yZCkge1xuICAgICAgICAgICAgICAgIHZhciBwcmV2aW91cyA9IGdldFJlY29yZFN0YXRlKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgaWYgKCFwcmV2aW91cyB8fCBnZXRSZXZpc2lvbihyZWNvcmQpID4gZ2V0UmV2aXNpb24ocHJldmlvdXMpKSB7XG4gICAgICAgICAgICAgICAgICAgIGxvZ0RlYnVnKCdTeW5jIC0+IFJlbW92ZWQgIycgKyBKU09OLnN0cmluZ2lmeShyZWNvcmQuaWQpICsgJyBmb3Igc3Vic2NyaXB0aW9uIHRvICcgKyBwdWJsaWNhdGlvbik7XG4gICAgICAgICAgICAgICAgICAgIC8vIFdlIGNvdWxkIGhhdmUgZm9yIHRoZSBzYW1lIHJlY29yZCBjb25zZWN1dGl2ZWx5IGZldGNoaW5nIGluIHRoaXMgb3JkZXI6XG4gICAgICAgICAgICAgICAgICAgIC8vIGRlbGV0ZSBpZDo0LCByZXYgMTAsIHRoZW4gYWRkIGlkOjQsIHJldiA5Li4uLiBieSBrZWVwaW5nIHRyYWNrIG9mIHdoYXQgd2FzIGRlbGV0ZWQsIHdlIHdpbGwgbm90IGFkZCB0aGUgcmVjb3JkIHNpbmNlIGl0IHdhcyBkZWxldGVkIHdpdGggYSBtb3N0IHJlY2VudCB0aW1lc3RhbXAuXG4gICAgICAgICAgICAgICAgICAgIHJlY29yZC5yZW1vdmVkID0gdHJ1ZTsgLy8gU28gd2Ugb25seSBmbGFnIGFzIHJlbW92ZWQsIGxhdGVyIG9uIHRoZSBnYXJiYWdlIGNvbGxlY3RvciB3aWxsIGdldCByaWQgb2YgaXQuICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHVwZGF0ZURhdGFTdG9yYWdlKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgIC8vIGlmIHRoZXJlIGlzIG5vIHByZXZpb3VzIHJlY29yZCB3ZSBkbyBub3QgbmVlZCB0byByZW1vdmVkIGFueSB0aGluZyBmcm9tIG91ciBzdG9yYWdlLiAgICAgXG4gICAgICAgICAgICAgICAgICAgIGlmIChwcmV2aW91cykge1xuICAgICAgICAgICAgICAgICAgICAgICAgc3luY0xpc3RlbmVyLm5vdGlmeSgncmVtb3ZlJywgcmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGRpc3Bvc2UocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGZ1bmN0aW9uIGRpc3Bvc2UocmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgJHN5bmNHYXJiYWdlQ29sbGVjdG9yLmRpc3Bvc2UoZnVuY3Rpb24gY29sbGVjdCgpIHtcbiAgICAgICAgICAgICAgICAgICAgdmFyIGV4aXN0aW5nUmVjb3JkID0gZ2V0UmVjb3JkU3RhdGUocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGV4aXN0aW5nUmVjb3JkICYmIHJlY29yZC5yZXZpc2lvbiA+PSBleGlzdGluZ1JlY29yZC5yZXZpc2lvblxuICAgICAgICAgICAgICAgICAgICApIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vbG9nRGVidWcoJ0NvbGxlY3QgTm93OicgKyBKU09OLnN0cmluZ2lmeShyZWNvcmQpKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGRlbGV0ZSByZWNvcmRTdGF0ZXNbZ2V0SWRWYWx1ZShyZWNvcmQuaWQpXTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBpc0V4aXN0aW5nU3RhdGVGb3IocmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuICEhZ2V0UmVjb3JkU3RhdGUocmVjb3JkKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gc2F2ZVJlY29yZFN0YXRlKHJlY29yZCkge1xuICAgICAgICAgICAgICAgIHJlY29yZFN0YXRlc1tnZXRJZFZhbHVlKHJlY29yZC5pZCldID0gcmVjb3JkO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBnZXRSZWNvcmRTdGF0ZShyZWNvcmQpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gcmVjb3JkU3RhdGVzW2dldElkVmFsdWUocmVjb3JkLmlkKV07XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIHVwZGF0ZVN5bmNlZE9iamVjdChyZWNvcmQpIHtcbiAgICAgICAgICAgICAgICBzYXZlUmVjb3JkU3RhdGUocmVjb3JkKTtcblxuICAgICAgICAgICAgICAgIGlmICghcmVjb3JkLnJlbW92ZSkge1xuICAgICAgICAgICAgICAgICAgICAkc3luY01lcmdlLnVwZGF0ZShjYWNoZSwgcmVjb3JkLCBzdHJpY3RNb2RlKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAkc3luY01lcmdlLmNsZWFyT2JqZWN0KGNhY2hlKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIHVwZGF0ZVN5bmNlZEFycmF5KHJlY29yZCkge1xuICAgICAgICAgICAgICAgIHZhciBleGlzdGluZyA9IGdldFJlY29yZFN0YXRlKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgaWYgKCFleGlzdGluZykge1xuICAgICAgICAgICAgICAgICAgICAvLyBhZGQgbmV3IGluc3RhbmNlXG4gICAgICAgICAgICAgICAgICAgIHNhdmVSZWNvcmRTdGF0ZShyZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICBpZiAoIXJlY29yZC5yZW1vdmVkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjYWNoZS5wdXNoKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAkc3luY01lcmdlLnVwZGF0ZShleGlzdGluZywgcmVjb3JkLCBzdHJpY3RNb2RlKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHJlY29yZC5yZW1vdmVkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjYWNoZS5zcGxpY2UoY2FjaGUuaW5kZXhPZihleGlzdGluZyksIDEpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBnZXRSZXZpc2lvbihyZWNvcmQpIHtcbiAgICAgICAgICAgICAgICAvLyB3aGF0IHJlc2VydmVkIGZpZWxkIGRvIHdlIHVzZSBhcyB0aW1lc3RhbXBcbiAgICAgICAgICAgICAgICBpZiAoYW5ndWxhci5pc0RlZmluZWQocmVjb3JkLnJldmlzaW9uKSkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gcmVjb3JkLnJldmlzaW9uO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBpZiAoYW5ndWxhci5pc0RlZmluZWQocmVjb3JkLnRpbWVzdGFtcCkpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHJlY29yZC50aW1lc3RhbXA7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignU3luYyByZXF1aXJlcyBhIHJldmlzaW9uIG9yIHRpbWVzdGFtcCBwcm9wZXJ0eSBpbiByZWNlaXZlZCAnICsgKG9iamVjdENsYXNzID8gJ29iamVjdCBbJyArIG9iamVjdENsYXNzLm5hbWUgKyAnXScgOiAncmVjb3JkJykpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqIHRoaXMgb2JqZWN0IFxuICAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gU3luY0xpc3RlbmVyKCkge1xuICAgICAgICAgICAgdmFyIGV2ZW50cyA9IHt9O1xuICAgICAgICAgICAgdmFyIGNvdW50ID0gMDtcblxuICAgICAgICAgICAgdGhpcy5ub3RpZnkgPSBub3RpZnk7XG4gICAgICAgICAgICB0aGlzLm9uID0gb247XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIG5vdGlmeShldmVudCwgZGF0YTEsIGRhdGEyKSB7XG4gICAgICAgICAgICAgICAgdmFyIGxpc3RlbmVycyA9IGV2ZW50c1tldmVudF07XG4gICAgICAgICAgICAgICAgaWYgKGxpc3RlbmVycykge1xuICAgICAgICAgICAgICAgICAgICBfLmZvckVhY2gobGlzdGVuZXJzLCBmdW5jdGlvbiAoY2FsbGJhY2ssIGlkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjYWxsYmFjayhkYXRhMSwgZGF0YTIpO1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogQHJldHVybnMgaGFuZGxlciB0byB1bnJlZ2lzdGVyIGxpc3RlbmVyXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIG9uKGV2ZW50LCBjYWxsYmFjaykge1xuICAgICAgICAgICAgICAgIHZhciBsaXN0ZW5lcnMgPSBldmVudHNbZXZlbnRdO1xuICAgICAgICAgICAgICAgIGlmICghbGlzdGVuZXJzKSB7XG4gICAgICAgICAgICAgICAgICAgIGxpc3RlbmVycyA9IGV2ZW50c1tldmVudF0gPSB7fTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgdmFyIGlkID0gY291bnQrKztcbiAgICAgICAgICAgICAgICBsaXN0ZW5lcnNbaWQrK10gPSBjYWxsYmFjaztcbiAgICAgICAgICAgICAgICByZXR1cm4gZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgICAgICBkZWxldGUgbGlzdGVuZXJzW2lkXTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9O1xuICAgIGZ1bmN0aW9uIGdldElkVmFsdWUoaWQpIHtcbiAgICAgICAgaWYgKCFfLmlzT2JqZWN0KGlkKSkge1xuICAgICAgICAgICAgcmV0dXJuIGlkO1xuICAgICAgICB9XG4gICAgICAgIC8vIGJ1aWxkIGNvbXBvc2l0ZSBrZXkgdmFsdWVcbiAgICAgICAgdmFyIHIgPSBfLmpvaW4oXy5tYXAoaWQsIGZ1bmN0aW9uICh2YWx1ZSkge1xuICAgICAgICAgICAgcmV0dXJuIHZhbHVlO1xuICAgICAgICB9KSwgJ34nKTtcbiAgICAgICAgcmV0dXJuIHI7XG4gICAgfVxuXG5cbiAgICBmdW5jdGlvbiBsb2dJbmZvKG1zZykge1xuICAgICAgICBpZiAoZGVidWcpIHtcbiAgICAgICAgICAgIGNvbnNvbGUuZGVidWcoJ1NZTkMoaW5mbyk6ICcgKyBtc2cpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gbG9nRGVidWcobXNnKSB7XG4gICAgICAgIGlmIChkZWJ1ZyA9PSAyKSB7XG4gICAgICAgICAgICBjb25zb2xlLmRlYnVnKCdTWU5DKGRlYnVnKTogJyArIG1zZyk7XG4gICAgICAgIH1cblxuICAgIH1cblxuXG5cbn07XG59KCkpO1xuIl19
