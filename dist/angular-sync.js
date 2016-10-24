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
        merge: mergeObject,
        clearObject: clearObject
    }


    /** merge an object with an other. Merge also inner objects and objects in array. 
     * Reference to the original objects are maintained in the destination object.
     * Only content is updated.
     *
     *@param <object> destination  object to merge into
     *@param <object> destination  object to merge into
     *@param <boolean> isStrictMode default false, if true would generate an error if inner objects in array do not have id field
     */
    function mergeObject(destination, source, isStrictMode) {
        if (!destination) {
            return source;// _.assign({}, source);;
        }
        // create new object containing only the properties of source merge with destination
        var object = {};
        for (var property in source) {
            if (_.isArray(source[property])) {
                object[property] = mergeArray(destination[property], source[property], isStrictMode);
            } else if (_.isFunction(source[property])) {
                object[property] = source[property];
            } else if (_.isObject(source[property])) {
                object[property] = mergeObject(destination[property], source[property], isStrictMode);
            } else {
                object[property] = source[property];
            }
        }

        clearObject(destination);
        _.assign(destination, object);

        return destination;
    }

    function mergeArray(destination, source, isStrictMode) {
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
                        array.push(mergeObject(_.find(destination, function (obj) {
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
 * Sync does not work if objects do not have BOTH id and revision field!!!!
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

            // wait for the initial fetch to complete then returns this subscription
            function waitForSubscriptionReady() {
                return deferredInitialization.promise.then(function () {
                    return sDs;
                });
            }

            // wait for the initial fetch to complete then returns the data
            function waitForDataReady() {
                return deferredInitialization.promise;
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
                    $syncMerge.merge(cache, record, strictMode);
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
                    $syncMerge.merge(existing, record, strictMode);
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

//# sourceMappingURL=data:application/json;charset=utf8;base64,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QSxHQUFBLE9BQUEsVUFBQTtnQkFDQSxJQUFBLFlBQUEsT0FBQTtnQkFDQSxJQUFBLENBQUEsV0FBQTtvQkFDQSxZQUFBLE9BQUEsU0FBQTs7Z0JBRUEsSUFBQSxLQUFBO2dCQUNBLFVBQUEsUUFBQTtnQkFDQSxPQUFBLFlBQUE7b0JBQ0EsT0FBQSxVQUFBOzs7OztJQUtBLFNBQUEsV0FBQSxJQUFBO1FBQ0EsSUFBQSxDQUFBLEVBQUEsU0FBQSxLQUFBO1lBQ0EsT0FBQTs7O1FBR0EsSUFBQSxJQUFBLEVBQUEsS0FBQSxFQUFBLElBQUEsSUFBQSxVQUFBLE9BQUE7WUFDQSxPQUFBO1lBQ0E7UUFDQSxPQUFBOzs7O0lBSUEsU0FBQSxRQUFBLEtBQUE7UUFDQSxJQUFBLE9BQUE7WUFDQSxRQUFBLE1BQUEsaUJBQUE7Ozs7SUFJQSxTQUFBLFNBQUEsS0FBQTtRQUNBLElBQUEsU0FBQSxHQUFBO1lBQ0EsUUFBQSxNQUFBLGtCQUFBOzs7Ozs7O0NBT0E7O0FBRUEiLCJmaWxlIjoiYW5ndWxhci1zeW5jLmpzIiwic291cmNlc0NvbnRlbnQiOlsiKGZ1bmN0aW9uKCkge1xuXCJ1c2Ugc3RyaWN0XCI7XG5cbmFuZ3VsYXJcbiAgICAubW9kdWxlKCdzeW5jJywgWydzb2NrZXRpby1hdXRoJ10pO1xufSgpKTtcblxuKGZ1bmN0aW9uKCkge1xuXCJ1c2Ugc3RyaWN0XCI7XG5cbmFuZ3VsYXJcbiAgICAubW9kdWxlKCdzeW5jJylcbiAgICAuZmFjdG9yeSgnJHN5bmNHYXJiYWdlQ29sbGVjdG9yJywgc3luY0dhcmJhZ2VDb2xsZWN0b3IpO1xuXG4vKipcbiAqIHNhZmVseSByZW1vdmUgZGVsZXRlZCByZWNvcmQvb2JqZWN0IGZyb20gbWVtb3J5IGFmdGVyIHRoZSBzeW5jIHByb2Nlc3MgZGlzcG9zZWQgdGhlbS5cbiAqIFxuICogVE9ETzogU2Vjb25kcyBzaG91bGQgcmVmbGVjdCB0aGUgbWF4IHRpbWUgIHRoYXQgc3luYyBjYWNoZSBpcyB2YWxpZCAobmV0d29yayBsb3NzIHdvdWxkIGZvcmNlIGEgcmVzeW5jKSwgd2hpY2ggc2hvdWxkIG1hdGNoIG1heERpc2Nvbm5lY3Rpb25UaW1lQmVmb3JlRHJvcHBpbmdTdWJzY3JpcHRpb24gb24gdGhlIHNlcnZlciBzaWRlLlxuICogXG4gKiBOb3RlOlxuICogcmVtb3ZlZCByZWNvcmQgc2hvdWxkIGJlIGRlbGV0ZWQgZnJvbSB0aGUgc3luYyBpbnRlcm5hbCBjYWNoZSBhZnRlciBhIHdoaWxlIHNvIHRoYXQgdGhleSBkbyBub3Qgc3RheSBpbiB0aGUgbWVtb3J5LiBUaGV5IGNhbm5vdCBiZSByZW1vdmVkIHRvbyBlYXJseSBhcyBhbiBvbGRlciB2ZXJzaW9uL3N0YW1wIG9mIHRoZSByZWNvcmQgY291bGQgYmUgcmVjZWl2ZWQgYWZ0ZXIgaXRzIHJlbW92YWwuLi53aGljaCB3b3VsZCByZS1hZGQgdG8gY2FjaGUuLi5kdWUgYXN5bmNocm9ub3VzIHByb2Nlc3NpbmcuLi5cbiAqL1xuZnVuY3Rpb24gc3luY0dhcmJhZ2VDb2xsZWN0b3IoKSB7XG4gICAgdmFyIGl0ZW1zID0gW107XG4gICAgdmFyIHNlY29uZHMgPSAyO1xuICAgIHZhciBzY2hlZHVsZWQgPSBmYWxzZTtcblxuICAgIHZhciBzZXJ2aWNlID0ge1xuICAgICAgICBzZXRTZWNvbmRzOiBzZXRTZWNvbmRzLFxuICAgICAgICBnZXRTZWNvbmRzOiBnZXRTZWNvbmRzLFxuICAgICAgICBkaXNwb3NlOiBkaXNwb3NlLFxuICAgICAgICBzY2hlZHVsZTogc2NoZWR1bGUsXG4gICAgICAgIHJ1bjogcnVuLFxuICAgICAgICBnZXRJdGVtQ291bnQ6IGdldEl0ZW1Db3VudFxuICAgIH07XG5cbiAgICByZXR1cm4gc2VydmljZTtcblxuICAgIC8vLy8vLy8vLy9cblxuICAgIGZ1bmN0aW9uIHNldFNlY29uZHModmFsdWUpIHtcbiAgICAgICAgc2Vjb25kcyA9IHZhbHVlO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIGdldFNlY29uZHMoKSB7XG4gICAgICAgIHJldHVybiBzZWNvbmRzO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIGdldEl0ZW1Db3VudCgpIHtcbiAgICAgICAgcmV0dXJuIGl0ZW1zLmxlbmd0aDtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBkaXNwb3NlKGNvbGxlY3QpIHtcbiAgICAgICAgaXRlbXMucHVzaCh7XG4gICAgICAgICAgICB0aW1lc3RhbXA6IERhdGUubm93KCksXG4gICAgICAgICAgICBjb2xsZWN0OiBjb2xsZWN0XG4gICAgICAgIH0pO1xuICAgICAgICBpZiAoIXNjaGVkdWxlZCkge1xuICAgICAgICAgICAgc2VydmljZS5zY2hlZHVsZSgpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gc2NoZWR1bGUoKSB7XG4gICAgICAgIGlmICghc2Vjb25kcykge1xuICAgICAgICAgICAgc2VydmljZS5ydW4oKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBzY2hlZHVsZWQgPSB0cnVlO1xuICAgICAgICBzZXRUaW1lb3V0KGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIHNlcnZpY2UucnVuKCk7XG4gICAgICAgICAgICBpZiAoaXRlbXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICAgIHNjaGVkdWxlKCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHNjaGVkdWxlZCA9IGZhbHNlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9LCBzZWNvbmRzICogMTAwMCk7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gcnVuKCkge1xuICAgICAgICB2YXIgdGltZW91dCA9IERhdGUubm93KCkgLSBzZWNvbmRzICogMTAwMDtcbiAgICAgICAgd2hpbGUgKGl0ZW1zLmxlbmd0aCA+IDAgJiYgaXRlbXNbMF0udGltZXN0YW1wIDw9IHRpbWVvdXQpIHtcbiAgICAgICAgICAgIGl0ZW1zLnNoaWZ0KCkuY29sbGVjdCgpO1xuICAgICAgICB9XG4gICAgfVxufVxufSgpKTtcblxuKGZ1bmN0aW9uKCkge1xuXCJ1c2Ugc3RyaWN0XCI7XG5cbmFuZ3VsYXJcbiAgICAubW9kdWxlKCdzeW5jJylcbiAgICAuZmFjdG9yeSgnJHN5bmNNZXJnZScsIHN5bmNNZXJnZSk7XG5cbmZ1bmN0aW9uIHN5bmNNZXJnZSgpIHtcblxuICAgIHJldHVybiB7XG4gICAgICAgIG1lcmdlOiBtZXJnZU9iamVjdCxcbiAgICAgICAgY2xlYXJPYmplY3Q6IGNsZWFyT2JqZWN0XG4gICAgfVxuXG5cbiAgICAvKiogbWVyZ2UgYW4gb2JqZWN0IHdpdGggYW4gb3RoZXIuIE1lcmdlIGFsc28gaW5uZXIgb2JqZWN0cyBhbmQgb2JqZWN0cyBpbiBhcnJheS4gXG4gICAgICogUmVmZXJlbmNlIHRvIHRoZSBvcmlnaW5hbCBvYmplY3RzIGFyZSBtYWludGFpbmVkIGluIHRoZSBkZXN0aW5hdGlvbiBvYmplY3QuXG4gICAgICogT25seSBjb250ZW50IGlzIHVwZGF0ZWQuXG4gICAgICpcbiAgICAgKkBwYXJhbSA8b2JqZWN0PiBkZXN0aW5hdGlvbiAgb2JqZWN0IHRvIG1lcmdlIGludG9cbiAgICAgKkBwYXJhbSA8b2JqZWN0PiBkZXN0aW5hdGlvbiAgb2JqZWN0IHRvIG1lcmdlIGludG9cbiAgICAgKkBwYXJhbSA8Ym9vbGVhbj4gaXNTdHJpY3RNb2RlIGRlZmF1bHQgZmFsc2UsIGlmIHRydWUgd291bGQgZ2VuZXJhdGUgYW4gZXJyb3IgaWYgaW5uZXIgb2JqZWN0cyBpbiBhcnJheSBkbyBub3QgaGF2ZSBpZCBmaWVsZFxuICAgICAqL1xuICAgIGZ1bmN0aW9uIG1lcmdlT2JqZWN0KGRlc3RpbmF0aW9uLCBzb3VyY2UsIGlzU3RyaWN0TW9kZSkge1xuICAgICAgICBpZiAoIWRlc3RpbmF0aW9uKSB7XG4gICAgICAgICAgICByZXR1cm4gc291cmNlOy8vIF8uYXNzaWduKHt9LCBzb3VyY2UpOztcbiAgICAgICAgfVxuICAgICAgICAvLyBjcmVhdGUgbmV3IG9iamVjdCBjb250YWluaW5nIG9ubHkgdGhlIHByb3BlcnRpZXMgb2Ygc291cmNlIG1lcmdlIHdpdGggZGVzdGluYXRpb25cbiAgICAgICAgdmFyIG9iamVjdCA9IHt9O1xuICAgICAgICBmb3IgKHZhciBwcm9wZXJ0eSBpbiBzb3VyY2UpIHtcbiAgICAgICAgICAgIGlmIChfLmlzQXJyYXkoc291cmNlW3Byb3BlcnR5XSkpIHtcbiAgICAgICAgICAgICAgICBvYmplY3RbcHJvcGVydHldID0gbWVyZ2VBcnJheShkZXN0aW5hdGlvbltwcm9wZXJ0eV0sIHNvdXJjZVtwcm9wZXJ0eV0sIGlzU3RyaWN0TW9kZSk7XG4gICAgICAgICAgICB9IGVsc2UgaWYgKF8uaXNGdW5jdGlvbihzb3VyY2VbcHJvcGVydHldKSkge1xuICAgICAgICAgICAgICAgIG9iamVjdFtwcm9wZXJ0eV0gPSBzb3VyY2VbcHJvcGVydHldO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChfLmlzT2JqZWN0KHNvdXJjZVtwcm9wZXJ0eV0pKSB7XG4gICAgICAgICAgICAgICAgb2JqZWN0W3Byb3BlcnR5XSA9IG1lcmdlT2JqZWN0KGRlc3RpbmF0aW9uW3Byb3BlcnR5XSwgc291cmNlW3Byb3BlcnR5XSwgaXNTdHJpY3RNb2RlKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgb2JqZWN0W3Byb3BlcnR5XSA9IHNvdXJjZVtwcm9wZXJ0eV07XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBjbGVhck9iamVjdChkZXN0aW5hdGlvbik7XG4gICAgICAgIF8uYXNzaWduKGRlc3RpbmF0aW9uLCBvYmplY3QpO1xuXG4gICAgICAgIHJldHVybiBkZXN0aW5hdGlvbjtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBtZXJnZUFycmF5KGRlc3RpbmF0aW9uLCBzb3VyY2UsIGlzU3RyaWN0TW9kZSkge1xuICAgICAgICBpZiAoIWRlc3RpbmF0aW9uKSB7XG4gICAgICAgICAgICByZXR1cm4gc291cmNlO1xuICAgICAgICB9XG4gICAgICAgIHZhciBhcnJheSA9IFtdO1xuICAgICAgICBzb3VyY2UuZm9yRWFjaChmdW5jdGlvbiAoaXRlbSkge1xuICAgICAgICAgICAgLy8gZG9lcyBub3QgdHJ5IHRvIG1haW50YWluIG9iamVjdCByZWZlcmVuY2VzIGluIGFycmF5c1xuICAgICAgICAgICAgLy8gc3VwZXIgbG9vc2UgbW9kZS5cbiAgICAgICAgICAgIGlmIChpc1N0cmljdE1vZGU9PT0nTk9ORScpIHtcbiAgICAgICAgICAgICAgICBhcnJheS5wdXNoKGl0ZW0pO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAvLyBvYmplY3QgaW4gYXJyYXkgbXVzdCBoYXZlIGFuIGlkIG90aGVyd2lzZSB3ZSBjYW4ndCBtYWludGFpbiB0aGUgaW5zdGFuY2UgcmVmZXJlbmNlXG4gICAgICAgICAgICAgICAgaWYgKCFfLmlzQXJyYXkoaXRlbSkgJiYgXy5pc09iamVjdChpdGVtKSkge1xuICAgICAgICAgICAgICAgICAgICAvLyBsZXQgdHJ5IHRvIGZpbmQgdGhlIGluc3RhbmNlXG4gICAgICAgICAgICAgICAgICAgIGlmIChhbmd1bGFyLmlzRGVmaW5lZChpdGVtLmlkKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgYXJyYXkucHVzaChtZXJnZU9iamVjdChfLmZpbmQoZGVzdGluYXRpb24sIGZ1bmN0aW9uIChvYmopIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gb2JqLmlkLnRvU3RyaW5nKCkgPT09IGl0ZW0uaWQudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pLCBpdGVtLCBpc1N0cmljdE1vZGUpKTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpc1N0cmljdE1vZGUpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ29iamVjdHMgaW4gYXJyYXkgbXVzdCBoYXZlIGFuIGlkIG90aGVyd2lzZSB3ZSBjYW5cXCd0IG1haW50YWluIHRoZSBpbnN0YW5jZSByZWZlcmVuY2UuICcgKyBKU09OLnN0cmluZ2lmeShpdGVtKSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICBhcnJheS5wdXNoKGl0ZW0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgYXJyYXkucHVzaChpdGVtKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIGRlc3RpbmF0aW9uLmxlbmd0aCA9IDA7XG4gICAgICAgIEFycmF5LnByb3RvdHlwZS5wdXNoLmFwcGx5KGRlc3RpbmF0aW9uLCBhcnJheSk7XG4gICAgICAgIC8vYW5ndWxhci5jb3B5KGRlc3RpbmF0aW9uLCBhcnJheSk7XG4gICAgICAgIHJldHVybiBkZXN0aW5hdGlvbjtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBjbGVhck9iamVjdChvYmplY3QpIHtcbiAgICAgICAgT2JqZWN0LmtleXMob2JqZWN0KS5mb3JFYWNoKGZ1bmN0aW9uIChrZXkpIHsgZGVsZXRlIG9iamVjdFtrZXldOyB9KTtcbiAgICB9XG59O1xufSgpKTtcblxuKGZ1bmN0aW9uKCkge1xuXCJ1c2Ugc3RyaWN0XCI7XG5cbi8qKlxuICogXG4gKiBTZXJ2aWNlIHRoYXQgYWxsb3dzIGFuIGFycmF5IG9mIGRhdGEgcmVtYWluIGluIHN5bmMgd2l0aCBiYWNrZW5kLlxuICogXG4gKiBcbiAqIGV4OlxuICogd2hlbiB0aGVyZSBpcyBhIG5vdGlmaWNhdGlvbiwgbm90aWNhdGlvblNlcnZpY2Ugbm90aWZpZXMgdGhhdCB0aGVyZSBpcyBzb21ldGhpbmcgbmV3Li4udGhlbiB0aGUgZGF0YXNldCBnZXQgdGhlIGRhdGEgYW5kIG5vdGlmaWVzIGFsbCBpdHMgY2FsbGJhY2suXG4gKiBcbiAqIE5PVEU6IFxuICogIFxuICogXG4gKiBQcmUtUmVxdWlzdGU6XG4gKiAtLS0tLS0tLS0tLS0tXG4gKiBTeW5jIGRvZXMgbm90IHdvcmsgaWYgb2JqZWN0cyBkbyBub3QgaGF2ZSBCT1RIIGlkIGFuZCByZXZpc2lvbiBmaWVsZCEhISFcbiAqIFxuICogV2hlbiB0aGUgYmFja2VuZCB3cml0ZXMgYW55IGRhdGEgdG8gdGhlIGRiIHRoYXQgYXJlIHN1cHBvc2VkIHRvIGJlIHN5bmNyb25pemVkOlxuICogSXQgbXVzdCBtYWtlIHN1cmUgZWFjaCBhZGQsIHVwZGF0ZSwgcmVtb3ZhbCBvZiByZWNvcmQgaXMgdGltZXN0YW1wZWQuXG4gKiBJdCBtdXN0IG5vdGlmeSB0aGUgZGF0YXN0cmVhbSAod2l0aCBub3RpZnlDaGFuZ2Ugb3Igbm90aWZ5UmVtb3ZhbCkgd2l0aCBzb21lIHBhcmFtcyBzbyB0aGF0IGJhY2tlbmQga25vd3MgdGhhdCBpdCBoYXMgdG8gcHVzaCBiYWNrIHRoZSBkYXRhIGJhY2sgdG8gdGhlIHN1YnNjcmliZXJzIChleDogdGhlIHRhc2tDcmVhdGlvbiB3b3VsZCBub3RpZnkgd2l0aCBpdHMgcGxhbklkKVxuKiBcbiAqIFxuICovXG5hbmd1bGFyXG4gICAgLm1vZHVsZSgnc3luYycpXG4gICAgLnByb3ZpZGVyKCckc3luYycsIHN5bmNQcm92aWRlcik7XG5cbmZ1bmN0aW9uIHN5bmNQcm92aWRlcigpIHtcblxuICAgIHZhciBkZWJ1ZztcblxuICAgIHRoaXMuc2V0RGVidWcgPSBmdW5jdGlvbiAodmFsdWUpIHtcbiAgICAgICAgZGVidWcgPSB2YWx1ZTtcbiAgICB9O1xuXG4gICAgdGhpcy4kZ2V0ID0gZnVuY3Rpb24gc3luYygkcm9vdFNjb3BlLCAkcSwgJHNvY2tldGlvLCAkc3luY0dhcmJhZ2VDb2xsZWN0b3IsICRzeW5jTWVyZ2UpIHtcblxuICAgICAgICB2YXIgcHVibGljYXRpb25MaXN0ZW5lcnMgPSB7fSxcbiAgICAgICAgICAgIHB1YmxpY2F0aW9uTGlzdGVuZXJDb3VudCA9IDA7XG4gICAgICAgIHZhciBHUkFDRV9QRVJJT0RfSU5fU0VDT05EUyA9IDg7XG4gICAgICAgIHZhciBTWU5DX1ZFUlNJT04gPSAnMS4yJztcblxuXG4gICAgICAgIGxpc3RlblRvU3luY05vdGlmaWNhdGlvbigpO1xuXG4gICAgICAgIHZhciBzZXJ2aWNlID0ge1xuICAgICAgICAgICAgc3Vic2NyaWJlOiBzdWJzY3JpYmUsXG4gICAgICAgICAgICByZXNvbHZlU3Vic2NyaXB0aW9uOiByZXNvbHZlU3Vic2NyaXB0aW9uLFxuICAgICAgICAgICAgZ2V0R3JhY2VQZXJpb2Q6IGdldEdyYWNlUGVyaW9kLFxuICAgICAgICAgICAgZ2V0SWRWYWx1ZTogZ2V0SWRWYWx1ZVxuICAgICAgICB9O1xuXG4gICAgICAgIHJldHVybiBzZXJ2aWNlO1xuXG4gICAgICAgIC8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vXG4gICAgICAgIC8qKlxuICAgICAgICAgKiBzdWJzY3JpYmUgdG8gcHVibGljYXRpb24gYW5kIHJldHVybnMgdGhlIHN1YnNjcmlwdGlvbiB3aGVuIGRhdGEgaXMgYXZhaWxhYmxlLiBcbiAgICAgICAgICogQHBhcmFtIHB1YmxpY2F0aW9uIG5hbWUuIG9uIHRoZSBzZXJ2ZXIgc2lkZSwgYSBwdWJsaWNhdGlvbiBzaGFsbCBleGlzdC4gZXg6IG1hZ2F6aW5lcy5zeW5jXG4gICAgICAgICAqIEBwYXJhbSBwYXJhbXMgICB0aGUgcGFyYW1zIG9iamVjdCBwYXNzZWQgdG8gdGhlIHN1YnNjcmlwdGlvbiwgZXg6IHttYWdhemluZUlkOidlbnRyZXByZW5ldXInfSlcbiAgICAgICAgICogQHBhcmFtIG9iamVjdENsYXNzIGFuIGluc3RhbmNlIG9mIHRoaXMgY2xhc3Mgd2lsbCBiZSBjcmVhdGVkIGZvciBlYWNoIHJlY29yZCByZWNlaXZlZC5cbiAgICAgICAgICogcmV0dXJucyBhIHByb21pc2UgcmV0dXJuaW5nIHRoZSBzdWJzY3JpcHRpb24gd2hlbiB0aGUgZGF0YSBpcyBzeW5jZWRcbiAgICAgICAgICogb3IgcmVqZWN0cyBpZiB0aGUgaW5pdGlhbCBzeW5jIGZhaWxzIHRvIGNvbXBsZXRlIGluIGEgbGltaXRlZCBhbW91bnQgb2YgdGltZS4gXG4gICAgICAgICAqIFxuICAgICAgICAgKiB0byBnZXQgdGhlIGRhdGEgZnJvbSB0aGUgZGF0YVNldCwganVzdCBkYXRhU2V0LmdldERhdGEoKVxuICAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gcmVzb2x2ZVN1YnNjcmlwdGlvbihwdWJsaWNhdGlvbk5hbWUsIHBhcmFtcywgb2JqZWN0Q2xhc3MpIHtcbiAgICAgICAgICAgIHZhciBkZWZlcnJlZCA9ICRxLmRlZmVyKCk7XG4gICAgICAgICAgICB2YXIgc0RzID0gc3Vic2NyaWJlKHB1YmxpY2F0aW9uTmFtZSkuc2V0T2JqZWN0Q2xhc3Mob2JqZWN0Q2xhc3MpO1xuXG4gICAgICAgICAgICAvLyBnaXZlIGEgbGl0dGxlIHRpbWUgZm9yIHN1YnNjcmlwdGlvbiB0byBmZXRjaCB0aGUgZGF0YS4uLm90aGVyd2lzZSBnaXZlIHVwIHNvIHRoYXQgd2UgZG9uJ3QgZ2V0IHN0dWNrIGluIGEgcmVzb2x2ZSB3YWl0aW5nIGZvcmV2ZXIuXG4gICAgICAgICAgICB2YXIgZ3JhY2VQZXJpb2QgPSBzZXRUaW1lb3V0KGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICBpZiAoIXNEcy5yZWFkeSkge1xuICAgICAgICAgICAgICAgICAgICBzRHMuZGVzdHJveSgpO1xuICAgICAgICAgICAgICAgICAgICBsb2dJbmZvKCdBdHRlbXB0IHRvIHN1YnNjcmliZSB0byBwdWJsaWNhdGlvbiAnICsgcHVibGljYXRpb25OYW1lICsgJyBmYWlsZWQnKTtcbiAgICAgICAgICAgICAgICAgICAgZGVmZXJyZWQucmVqZWN0KCdTWU5DX1RJTUVPVVQnKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9LCBHUkFDRV9QRVJJT0RfSU5fU0VDT05EUyAqIDEwMDApO1xuXG4gICAgICAgICAgICBzRHMuc2V0UGFyYW1ldGVycyhwYXJhbXMpXG4gICAgICAgICAgICAgICAgLndhaXRGb3JEYXRhUmVhZHkoKVxuICAgICAgICAgICAgICAgIC50aGVuKGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICAgICAgY2xlYXJUaW1lb3V0KGdyYWNlUGVyaW9kKTtcbiAgICAgICAgICAgICAgICAgICAgZGVmZXJyZWQucmVzb2x2ZShzRHMpO1xuICAgICAgICAgICAgICAgIH0pLmNhdGNoKGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICAgICAgY2xlYXJUaW1lb3V0KGdyYWNlUGVyaW9kKTtcbiAgICAgICAgICAgICAgICAgICAgc0RzLmRlc3Ryb3koKTtcbiAgICAgICAgICAgICAgICAgICAgZGVmZXJyZWQucmVqZWN0KCdGYWlsZWQgdG8gc3Vic2NyaWJlIHRvIHB1YmxpY2F0aW9uICcgKyBwdWJsaWNhdGlvbk5hbWUgKyAnIGZhaWxlZCcpO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgcmV0dXJuIGRlZmVycmVkLnByb21pc2U7XG4gICAgICAgIH1cblxuICAgICAgICAvKipcbiAgICAgICAgICogXG4gICAgICAgICAqIGZvciB0ZXN0IHB1cnBvc2VzLCByZXR1cm5zIHRoZSB0aW1lIHJlc29sdmVTdWJzY3JpcHRpb24gYmVmb3JlIGl0IHRpbWVzIG91dC5cbiAgICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIGdldEdyYWNlUGVyaW9kKCkge1xuICAgICAgICAgICAgcmV0dXJuIEdSQUNFX1BFUklPRF9JTl9TRUNPTkRTO1xuICAgICAgICB9XG4gICAgICAgIC8qKlxuICAgICAgICAgKiBzdWJzY3JpYmUgdG8gcHVibGljYXRpb24uIEl0IHdpbGwgbm90IHN5bmMgdW50aWwgeW91IHNldCB0aGUgcGFyYW1zLlxuICAgICAgICAgKiBcbiAgICAgICAgICogQHBhcmFtIHB1YmxpY2F0aW9uIG5hbWUuIG9uIHRoZSBzZXJ2ZXIgc2lkZSwgYSBwdWJsaWNhdGlvbiBzaGFsbCBleGlzdC4gZXg6IG1hZ2F6aW5lcy5zeW5jXG4gICAgICAgICAqIEBwYXJhbSBwYXJhbXMgICB0aGUgcGFyYW1zIG9iamVjdCBwYXNzZWQgdG8gdGhlIHN1YnNjcmlwdGlvbiwgZXg6IHttYWdhemluZUlkOidlbnRyZXByZW5ldXInfSlcbiAgICAgICAgICogcmV0dXJucyBzdWJzY3JpcHRpb25cbiAgICAgICAgICogXG4gICAgICAgICAqL1xuICAgICAgICBmdW5jdGlvbiBzdWJzY3JpYmUocHVibGljYXRpb25OYW1lLCBzY29wZSkge1xuICAgICAgICAgICAgcmV0dXJuIG5ldyBTdWJzY3JpcHRpb24ocHVibGljYXRpb25OYW1lLCBzY29wZSk7XG4gICAgICAgIH1cblxuXG5cbiAgICAgICAgLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy9cbiAgICAgICAgLy8gSEVMUEVSU1xuXG4gICAgICAgIC8vIGV2ZXJ5IHN5bmMgbm90aWZpY2F0aW9uIGNvbWVzIHRocnUgdGhlIHNhbWUgZXZlbnQgdGhlbiBpdCBpcyBkaXNwYXRjaGVzIHRvIHRoZSB0YXJnZXRlZCBzdWJzY3JpcHRpb25zLlxuICAgICAgICBmdW5jdGlvbiBsaXN0ZW5Ub1N5bmNOb3RpZmljYXRpb24oKSB7XG4gICAgICAgICAgICAkc29ja2V0aW8ub24oJ1NZTkNfTk9XJywgZnVuY3Rpb24gKHN1Yk5vdGlmaWNhdGlvbiwgZm4pIHtcbiAgICAgICAgICAgICAgICBsb2dJbmZvKCdTeW5jaW5nIHdpdGggc3Vic2NyaXB0aW9uIFtuYW1lOicgKyBzdWJOb3RpZmljYXRpb24ubmFtZSArICcsIGlkOicgKyBzdWJOb3RpZmljYXRpb24uc3Vic2NyaXB0aW9uSWQgKyAnICwgcGFyYW1zOicgKyBKU09OLnN0cmluZ2lmeShzdWJOb3RpZmljYXRpb24ucGFyYW1zKSArICddLiBSZWNvcmRzOicgKyBzdWJOb3RpZmljYXRpb24ucmVjb3Jkcy5sZW5ndGggKyAnWycgKyAoc3ViTm90aWZpY2F0aW9uLmRpZmYgPyAnRGlmZicgOiAnQWxsJykgKyAnXScpO1xuICAgICAgICAgICAgICAgIHZhciBsaXN0ZW5lcnMgPSBwdWJsaWNhdGlvbkxpc3RlbmVyc1tzdWJOb3RpZmljYXRpb24ubmFtZV07XG4gICAgICAgICAgICAgICAgaWYgKGxpc3RlbmVycykge1xuICAgICAgICAgICAgICAgICAgICBmb3IgKHZhciBsaXN0ZW5lciBpbiBsaXN0ZW5lcnMpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxpc3RlbmVyc1tsaXN0ZW5lcl0oc3ViTm90aWZpY2F0aW9uKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBmbignU1lOQ0VEJyk7IC8vIGxldCBrbm93IHRoZSBiYWNrZW5kIHRoZSBjbGllbnQgd2FzIGFibGUgdG8gc3luYy5cbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9O1xuXG5cbiAgICAgICAgLy8gdGhpcyBhbGxvd3MgYSBkYXRhc2V0IHRvIGxpc3RlbiB0byBhbnkgU1lOQ19OT1cgZXZlbnQuLmFuZCBpZiB0aGUgbm90aWZpY2F0aW9uIGlzIGFib3V0IGl0cyBkYXRhLlxuICAgICAgICBmdW5jdGlvbiBhZGRQdWJsaWNhdGlvbkxpc3RlbmVyKHN0cmVhbU5hbWUsIGNhbGxiYWNrKSB7XG4gICAgICAgICAgICB2YXIgdWlkID0gcHVibGljYXRpb25MaXN0ZW5lckNvdW50Kys7XG4gICAgICAgICAgICB2YXIgbGlzdGVuZXJzID0gcHVibGljYXRpb25MaXN0ZW5lcnNbc3RyZWFtTmFtZV07XG4gICAgICAgICAgICBpZiAoIWxpc3RlbmVycykge1xuICAgICAgICAgICAgICAgIHB1YmxpY2F0aW9uTGlzdGVuZXJzW3N0cmVhbU5hbWVdID0gbGlzdGVuZXJzID0ge307XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBsaXN0ZW5lcnNbdWlkXSA9IGNhbGxiYWNrO1xuXG4gICAgICAgICAgICByZXR1cm4gZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgIGRlbGV0ZSBsaXN0ZW5lcnNbdWlkXTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAgICAgLy8gU3Vic2NyaXB0aW9uIG9iamVjdFxuICAgICAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAgICAgLyoqXG4gICAgICAgICAqIGEgc3Vic2NyaXB0aW9uIHN5bmNocm9uaXplcyB3aXRoIHRoZSBiYWNrZW5kIGZvciBhbnkgYmFja2VuZCBkYXRhIGNoYW5nZSBhbmQgbWFrZXMgdGhhdCBkYXRhIGF2YWlsYWJsZSB0byBhIGNvbnRyb2xsZXIuXG4gICAgICAgICAqIFxuICAgICAgICAgKiAgV2hlbiBjbGllbnQgc3Vic2NyaWJlcyB0byBhbiBzeW5jcm9uaXplZCBhcGksIGFueSBkYXRhIGNoYW5nZSB0aGF0IGltcGFjdHMgdGhlIGFwaSByZXN1bHQgV0lMTCBiZSBQVVNIZWQgdG8gdGhlIGNsaWVudC5cbiAgICAgICAgICogSWYgdGhlIGNsaWVudCBkb2VzIE5PVCBzdWJzY3JpYmUgb3Igc3RvcCBzdWJzY3JpYmUsIGl0IHdpbGwgbm8gbG9uZ2VyIHJlY2VpdmUgdGhlIFBVU0guIFxuICAgICAgICAgKiAgICBcbiAgICAgICAgICogaWYgdGhlIGNvbm5lY3Rpb24gaXMgbG9zdCBmb3IgYSBzaG9ydCB0aW1lIChkdXJhdGlvbiBkZWZpbmVkIG9uIHNlcnZlci1zaWRlKSwgdGhlIHNlcnZlciBxdWV1ZXMgdGhlIGNoYW5nZXMgaWYgYW55LiBcbiAgICAgICAgICogV2hlbiB0aGUgY29ubmVjdGlvbiByZXR1cm5zLCB0aGUgbWlzc2luZyBkYXRhIGF1dG9tYXRpY2FsbHkgIHdpbGwgYmUgUFVTSGVkIHRvIHRoZSBzdWJzY3JpYmluZyBjbGllbnQuXG4gICAgICAgICAqIGlmIHRoZSBjb25uZWN0aW9uIGlzIGxvc3QgZm9yIGEgbG9uZyB0aW1lIChkdXJhdGlvbiBkZWZpbmVkIG9uIHRoZSBzZXJ2ZXIpLCB0aGUgc2VydmVyIHdpbGwgZGVzdHJveSB0aGUgc3Vic2NyaXB0aW9uLiBUbyBzaW1wbGlmeSwgdGhlIGNsaWVudCB3aWxsIHJlc3Vic2NyaWJlIGF0IGl0cyByZWNvbm5lY3Rpb24gYW5kIGdldCBhbGwgZGF0YS5cbiAgICAgICAgICogXG4gICAgICAgICAqIHN1YnNjcmlwdGlvbiBvYmplY3QgcHJvdmlkZXMgMyBjYWxsYmFja3MgKGFkZCx1cGRhdGUsIGRlbCkgd2hpY2ggYXJlIGNhbGxlZCBkdXJpbmcgc3luY2hyb25pemF0aW9uLlxuICAgICAgICAgKiAgICAgIFxuICAgICAgICAgKiBTY29wZSB3aWxsIGFsbG93IHRoZSBzdWJzY3JpcHRpb24gc3RvcCBzeW5jaHJvbml6aW5nIGFuZCBjYW5jZWwgcmVnaXN0cmF0aW9uIHdoZW4gaXQgaXMgZGVzdHJveWVkLiBcbiAgICAgICAgICogIFxuICAgICAgICAgKiBDb25zdHJ1Y3RvcjpcbiAgICAgICAgICogXG4gICAgICAgICAqIEBwYXJhbSBwdWJsaWNhdGlvbiwgdGhlIHB1YmxpY2F0aW9uIG11c3QgZXhpc3Qgb24gdGhlIHNlcnZlciBzaWRlXG4gICAgICAgICAqIEBwYXJhbSBzY29wZSwgYnkgZGVmYXVsdCAkcm9vdFNjb3BlLCBidXQgY2FuIGJlIG1vZGlmaWVkIGxhdGVyIG9uIHdpdGggYXR0YWNoIG1ldGhvZC5cbiAgICAgICAgICovXG5cbiAgICAgICAgZnVuY3Rpb24gU3Vic2NyaXB0aW9uKHB1YmxpY2F0aW9uLCBzY29wZSkge1xuICAgICAgICAgICAgdmFyIHRpbWVzdGFtcEZpZWxkLCBpc1N5bmNpbmdPbiA9IGZhbHNlLCBpc1NpbmdsZSwgdXBkYXRlRGF0YVN0b3JhZ2UsIGNhY2hlLCBpc0luaXRpYWxQdXNoQ29tcGxldGVkLCBkZWZlcnJlZEluaXRpYWxpemF0aW9uLCBzdHJpY3RNb2RlO1xuICAgICAgICAgICAgdmFyIG9uUmVhZHlPZmYsIGZvcm1hdFJlY29yZDtcbiAgICAgICAgICAgIHZhciByZWNvbm5lY3RPZmYsIHB1YmxpY2F0aW9uTGlzdGVuZXJPZmYsIGRlc3Ryb3lPZmY7XG4gICAgICAgICAgICB2YXIgb2JqZWN0Q2xhc3M7XG4gICAgICAgICAgICB2YXIgc3Vic2NyaXB0aW9uSWQ7XG5cbiAgICAgICAgICAgIHZhciBzRHMgPSB0aGlzO1xuICAgICAgICAgICAgdmFyIHN1YlBhcmFtcyA9IHt9O1xuICAgICAgICAgICAgdmFyIHJlY29yZFN0YXRlcyA9IHt9O1xuICAgICAgICAgICAgdmFyIGlubmVyU2NvcGU7Ly89ICRyb290U2NvcGUuJG5ldyh0cnVlKTtcbiAgICAgICAgICAgIHZhciBzeW5jTGlzdGVuZXIgPSBuZXcgU3luY0xpc3RlbmVyKCk7XG5cblxuICAgICAgICAgICAgdGhpcy5yZWFkeSA9IGZhbHNlO1xuICAgICAgICAgICAgdGhpcy5zeW5jT24gPSBzeW5jT247XG4gICAgICAgICAgICB0aGlzLnN5bmNPZmYgPSBzeW5jT2ZmO1xuICAgICAgICAgICAgdGhpcy5zZXRPblJlYWR5ID0gc2V0T25SZWFkeTtcblxuICAgICAgICAgICAgdGhpcy5vblJlYWR5ID0gb25SZWFkeTtcbiAgICAgICAgICAgIHRoaXMub25VcGRhdGUgPSBvblVwZGF0ZTtcbiAgICAgICAgICAgIHRoaXMub25BZGQgPSBvbkFkZDtcbiAgICAgICAgICAgIHRoaXMub25SZW1vdmUgPSBvblJlbW92ZTtcblxuICAgICAgICAgICAgdGhpcy5nZXREYXRhID0gZ2V0RGF0YTtcbiAgICAgICAgICAgIHRoaXMuc2V0UGFyYW1ldGVycyA9IHNldFBhcmFtZXRlcnM7XG5cbiAgICAgICAgICAgIHRoaXMud2FpdEZvckRhdGFSZWFkeSA9IHdhaXRGb3JEYXRhUmVhZHk7XG4gICAgICAgICAgICB0aGlzLndhaXRGb3JTdWJzY3JpcHRpb25SZWFkeSA9IHdhaXRGb3JTdWJzY3JpcHRpb25SZWFkeTtcblxuICAgICAgICAgICAgdGhpcy5zZXRGb3JjZSA9IHNldEZvcmNlO1xuICAgICAgICAgICAgdGhpcy5pc1N5bmNpbmcgPSBpc1N5bmNpbmc7XG4gICAgICAgICAgICB0aGlzLmlzUmVhZHkgPSBpc1JlYWR5O1xuXG4gICAgICAgICAgICB0aGlzLnNldFNpbmdsZSA9IHNldFNpbmdsZTtcblxuICAgICAgICAgICAgdGhpcy5zZXRPYmplY3RDbGFzcyA9IHNldE9iamVjdENsYXNzO1xuICAgICAgICAgICAgdGhpcy5nZXRPYmplY3RDbGFzcyA9IGdldE9iamVjdENsYXNzO1xuXG4gICAgICAgICAgICB0aGlzLnNldFN0cmljdE1vZGUgPSBzZXRTdHJpY3RNb2RlO1xuXG4gICAgICAgICAgICB0aGlzLmF0dGFjaCA9IGF0dGFjaDtcbiAgICAgICAgICAgIHRoaXMuZGVzdHJveSA9IGRlc3Ryb3k7XG5cbiAgICAgICAgICAgIHRoaXMuaXNFeGlzdGluZ1N0YXRlRm9yID0gaXNFeGlzdGluZ1N0YXRlRm9yOyAvLyBmb3IgdGVzdGluZyBwdXJwb3Nlc1xuXG4gICAgICAgICAgICBzZXRTaW5nbGUoZmFsc2UpO1xuXG4gICAgICAgICAgICAvLyB0aGlzIHdpbGwgbWFrZSBzdXJlIHRoYXQgdGhlIHN1YnNjcmlwdGlvbiBpcyByZWxlYXNlZCBmcm9tIHNlcnZlcnMgaWYgdGhlIGFwcCBjbG9zZXMgKGNsb3NlIGJyb3dzZXIsIHJlZnJlc2guLi4pXG4gICAgICAgICAgICBhdHRhY2goc2NvcGUgfHwgJHJvb3RTY29wZSk7XG5cbiAgICAgICAgICAgIC8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy9cblxuICAgICAgICAgICAgZnVuY3Rpb24gZGVzdHJveSgpIHtcbiAgICAgICAgICAgICAgICBzeW5jT2ZmKCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKiB0aGlzIHdpbGwgYmUgY2FsbGVkIHdoZW4gZGF0YSBpcyBhdmFpbGFibGUgXG4gICAgICAgICAgICAgKiAgaXQgbWVhbnMgcmlnaHQgYWZ0ZXIgZWFjaCBzeW5jIVxuICAgICAgICAgICAgICogXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBzZXRPblJlYWR5KGNhbGxiYWNrKSB7XG4gICAgICAgICAgICAgICAgaWYgKG9uUmVhZHlPZmYpIHtcbiAgICAgICAgICAgICAgICAgICAgb25SZWFkeU9mZigpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBvblJlYWR5T2ZmID0gb25SZWFkeShjYWxsYmFjayk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgKiBmb3JjZSByZXN5bmNpbmcgZnJvbSBzY3JhdGNoIGV2ZW4gaWYgdGhlIHBhcmFtZXRlcnMgaGF2ZSBub3QgY2hhbmdlZFxuICAgICAgICAgICAgICogXG4gICAgICAgICAgICAgKiBpZiBvdXRzaWRlIGNvZGUgaGFzIG1vZGlmaWVkIHRoZSBkYXRhIGFuZCB5b3UgbmVlZCB0byByb2xsYmFjaywgeW91IGNvdWxkIGNvbnNpZGVyIGZvcmNpbmcgYSByZWZyZXNoIHdpdGggdGhpcy4gQmV0dGVyIHNvbHV0aW9uIHNob3VsZCBiZSBmb3VuZCB0aGFuIHRoYXQuXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICAqL1xuICAgICAgICAgICAgZnVuY3Rpb24gc2V0Rm9yY2UodmFsdWUpIHtcbiAgICAgICAgICAgICAgICBpZiAodmFsdWUpIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gcXVpY2sgaGFjayB0byBmb3JjZSB0byByZWxvYWQuLi5yZWNvZGUgbGF0ZXIuXG4gICAgICAgICAgICAgICAgICAgIHNEcy5zeW5jT2ZmKCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogaWYgc2V0IHRvIHRydWUsIGlmIGFuIG9iamVjdCB3aXRoaW4gYW4gYXJyYXkgcHJvcGVydHkgb2YgdGhlIHJlY29yZCB0byBzeW5jIGhhcyBubyBJRCBmaWVsZC5cbiAgICAgICAgICAgICAqIGFuIGVycm9yIHdvdWxkIGJlIHRocm93bi5cbiAgICAgICAgICAgICAqIEl0IGlzIGltcG9ydGFudCBpZiB3ZSB3YW50IHRvIGJlIGFibGUgdG8gbWFpbnRhaW4gaW5zdGFuY2UgcmVmZXJlbmNlcyBldmVuIGZvciB0aGUgb2JqZWN0cyBpbnNpZGUgYXJyYXlzLlxuICAgICAgICAgICAgICpcbiAgICAgICAgICAgICAqIEZvcmNlcyB1cyB0byB1c2UgaWQgZXZlcnkgd2hlcmUuXG4gICAgICAgICAgICAgKlxuICAgICAgICAgICAgICogU2hvdWxkIGJlIHRoZSBkZWZhdWx0Li4uYnV0IHRvbyByZXN0cmljdGl2ZSBmb3Igbm93LlxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBzZXRTdHJpY3RNb2RlKHZhbHVlKSB7XG4gICAgICAgICAgICAgICAgc3RyaWN0TW9kZSA9IHZhbHVlO1xuICAgICAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogVGhlIGZvbGxvd2luZyBvYmplY3Qgd2lsbCBiZSBidWlsdCB1cG9uIGVhY2ggcmVjb3JkIHJlY2VpdmVkIGZyb20gdGhlIGJhY2tlbmRcbiAgICAgICAgICAgICAqIFxuICAgICAgICAgICAgICogVGhpcyBjYW5ub3QgYmUgbW9kaWZpZWQgYWZ0ZXIgdGhlIHN5bmMgaGFzIHN0YXJ0ZWQuXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICAqIEBwYXJhbSBjbGFzc1ZhbHVlXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIHNldE9iamVjdENsYXNzKGNsYXNzVmFsdWUpIHtcbiAgICAgICAgICAgICAgICBpZiAoZGVmZXJyZWRJbml0aWFsaXphdGlvbikge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIG9iamVjdENsYXNzID0gY2xhc3NWYWx1ZTtcbiAgICAgICAgICAgICAgICBmb3JtYXRSZWNvcmQgPSBmdW5jdGlvbiAocmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBuZXcgb2JqZWN0Q2xhc3MocmVjb3JkKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgc2V0U2luZ2xlKGlzU2luZ2xlKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBnZXRPYmplY3RDbGFzcygpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gb2JqZWN0Q2xhc3M7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogdGhpcyBmdW5jdGlvbiBzdGFydHMgdGhlIHN5bmNpbmcuXG4gICAgICAgICAgICAgKiBPbmx5IHB1YmxpY2F0aW9uIHB1c2hpbmcgZGF0YSBtYXRjaGluZyBvdXIgZmV0Y2hpbmcgcGFyYW1zIHdpbGwgYmUgcmVjZWl2ZWQuXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICAqIGV4OiBmb3IgYSBwdWJsaWNhdGlvbiBuYW1lZCBcIm1hZ2F6aW5lcy5zeW5jXCIsIGlmIGZldGNoaW5nIHBhcmFtcyBlcXVhbGxlZCB7bWFnYXppbk5hbWU6J2NhcnMnfSwgdGhlIG1hZ2F6aW5lIGNhcnMgZGF0YSB3b3VsZCBiZSByZWNlaXZlZCBieSB0aGlzIHN1YnNjcmlwdGlvbi5cbiAgICAgICAgICAgICAqIFxuICAgICAgICAgICAgICogQHBhcmFtIGZldGNoaW5nUGFyYW1zXG4gICAgICAgICAgICAgKiBAcGFyYW0gb3B0aW9uc1xuICAgICAgICAgICAgICogXG4gICAgICAgICAgICAgKiBAcmV0dXJucyBhIHByb21pc2UgdGhhdCByZXNvbHZlcyB3aGVuIGRhdGEgaXMgYXJyaXZlZC5cbiAgICAgICAgICAgICAqL1xuICAgICAgICAgICAgZnVuY3Rpb24gc2V0UGFyYW1ldGVycyhmZXRjaGluZ1BhcmFtcywgb3B0aW9ucykge1xuICAgICAgICAgICAgICAgIGlmIChpc1N5bmNpbmdPbiAmJiBhbmd1bGFyLmVxdWFscyhmZXRjaGluZ1BhcmFtcyB8fCB7fSwgc3ViUGFyYW1zKSkge1xuICAgICAgICAgICAgICAgICAgICAvLyBpZiB0aGUgcGFyYW1zIGhhdmUgbm90IGNoYW5nZWQsIGp1c3QgcmV0dXJucyB3aXRoIGN1cnJlbnQgZGF0YS5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHNEczsgLy8kcS5yZXNvbHZlKGdldERhdGEoKSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHN5bmNPZmYoKTtcbiAgICAgICAgICAgICAgICBpZiAoIWlzU2luZ2xlKSB7XG4gICAgICAgICAgICAgICAgICAgIGNhY2hlLmxlbmd0aCA9IDA7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgc3ViUGFyYW1zID0gZmV0Y2hpbmdQYXJhbXMgfHwge307XG4gICAgICAgICAgICAgICAgb3B0aW9ucyA9IG9wdGlvbnMgfHwge307XG4gICAgICAgICAgICAgICAgaWYgKGFuZ3VsYXIuaXNEZWZpbmVkKG9wdGlvbnMuc2luZ2xlKSkge1xuICAgICAgICAgICAgICAgICAgICBzZXRTaW5nbGUob3B0aW9ucy5zaW5nbGUpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBzeW5jT24oKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyB3YWl0IGZvciB0aGUgaW5pdGlhbCBmZXRjaCB0byBjb21wbGV0ZSB0aGVuIHJldHVybnMgdGhpcyBzdWJzY3JpcHRpb25cbiAgICAgICAgICAgIGZ1bmN0aW9uIHdhaXRGb3JTdWJzY3JpcHRpb25SZWFkeSgpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZGVmZXJyZWRJbml0aWFsaXphdGlvbi5wcm9taXNlLnRoZW4oZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyB3YWl0IGZvciB0aGUgaW5pdGlhbCBmZXRjaCB0byBjb21wbGV0ZSB0aGVuIHJldHVybnMgdGhlIGRhdGFcbiAgICAgICAgICAgIGZ1bmN0aW9uIHdhaXRGb3JEYXRhUmVhZHkoKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGRlZmVycmVkSW5pdGlhbGl6YXRpb24ucHJvbWlzZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy8gZG9lcyB0aGUgZGF0YXNldCByZXR1cm5zIG9ubHkgb25lIG9iamVjdD8gbm90IGFuIGFycmF5P1xuICAgICAgICAgICAgZnVuY3Rpb24gc2V0U2luZ2xlKHZhbHVlKSB7XG4gICAgICAgICAgICAgICAgaWYgKGRlZmVycmVkSW5pdGlhbGl6YXRpb24pIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICB2YXIgdXBkYXRlRm47XG4gICAgICAgICAgICAgICAgaXNTaW5nbGUgPSB2YWx1ZTtcbiAgICAgICAgICAgICAgICBpZiAodmFsdWUpIHtcbiAgICAgICAgICAgICAgICAgICAgdXBkYXRlRm4gPSB1cGRhdGVTeW5jZWRPYmplY3Q7XG4gICAgICAgICAgICAgICAgICAgIGNhY2hlID0gb2JqZWN0Q2xhc3MgPyBuZXcgb2JqZWN0Q2xhc3Moe30pIDoge307XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgdXBkYXRlRm4gPSB1cGRhdGVTeW5jZWRBcnJheTtcbiAgICAgICAgICAgICAgICAgICAgY2FjaGUgPSBbXTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICB1cGRhdGVEYXRhU3RvcmFnZSA9IGZ1bmN0aW9uIChyZWNvcmQpIHtcbiAgICAgICAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHVwZGF0ZUZuKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGUubWVzc2FnZSA9ICdSZWNlaXZlZCBJbnZhbGlkIG9iamVjdCBmcm9tIHB1YmxpY2F0aW9uIFsnICsgcHVibGljYXRpb24gKyAnXTogJyArIEpTT04uc3RyaW5naWZ5KHJlY29yZCkgKyAnLiBERVRBSUxTOiAnICsgZS5tZXNzYWdlO1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgZTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIHJldHVybnMgdGhlIG9iamVjdCBvciBhcnJheSBpbiBzeW5jXG4gICAgICAgICAgICBmdW5jdGlvbiBnZXREYXRhKCkge1xuICAgICAgICAgICAgICAgIHJldHVybiBjYWNoZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgKiB0aGUgZGF0YXNldCB3aWxsIHN0YXJ0IGxpc3RlbmluZyB0byB0aGUgZGF0YXN0cmVhbSBcbiAgICAgICAgICAgICAqIFxuICAgICAgICAgICAgICogTm90ZSBEdXJpbmcgdGhlIHN5bmMsIGl0IHdpbGwgYWxzbyBjYWxsIHRoZSBvcHRpb25hbCBjYWxsYmFja3MgLSBhZnRlciBwcm9jZXNzaW5nIEVBQ0ggcmVjb3JkIHJlY2VpdmVkLlxuICAgICAgICAgICAgICogXG4gICAgICAgICAgICAgKiBAcmV0dXJucyBhIHByb21pc2UgdGhhdCB3aWxsIGJlIHJlc29sdmVkIHdoZW4gdGhlIGRhdGEgaXMgcmVhZHkuXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIHN5bmNPbigpIHtcbiAgICAgICAgICAgICAgICBpZiAoaXNTeW5jaW5nT24pIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGRlZmVycmVkSW5pdGlhbGl6YXRpb24ucHJvbWlzZTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgZGVmZXJyZWRJbml0aWFsaXphdGlvbiA9ICRxLmRlZmVyKCk7XG4gICAgICAgICAgICAgICAgaXNJbml0aWFsUHVzaENvbXBsZXRlZCA9IGZhbHNlO1xuICAgICAgICAgICAgICAgIGxvZ0luZm8oJ1N5bmMgJyArIHB1YmxpY2F0aW9uICsgJyBvbi4gUGFyYW1zOicgKyBKU09OLnN0cmluZ2lmeShzdWJQYXJhbXMpKTtcbiAgICAgICAgICAgICAgICBpc1N5bmNpbmdPbiA9IHRydWU7XG4gICAgICAgICAgICAgICAgcmVnaXN0ZXJTdWJzY3JpcHRpb24oKTtcbiAgICAgICAgICAgICAgICByZWFkeUZvckxpc3RlbmluZygpO1xuICAgICAgICAgICAgICAgIHJldHVybiBkZWZlcnJlZEluaXRpYWxpemF0aW9uLnByb21pc2U7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogdGhlIGRhdGFzZXQgaXMgbm8gbG9uZ2VyIGxpc3RlbmluZyBhbmQgd2lsbCBub3QgY2FsbCBhbnkgY2FsbGJhY2tcbiAgICAgICAgICAgICAqL1xuICAgICAgICAgICAgZnVuY3Rpb24gc3luY09mZigpIHtcbiAgICAgICAgICAgICAgICBpZiAoZGVmZXJyZWRJbml0aWFsaXphdGlvbikge1xuICAgICAgICAgICAgICAgICAgICAvLyBpZiB0aGVyZSBpcyBjb2RlIHdhaXRpbmcgb24gdGhpcyBwcm9taXNlLi4gZXggKGxvYWQgaW4gcmVzb2x2ZSlcbiAgICAgICAgICAgICAgICAgICAgZGVmZXJyZWRJbml0aWFsaXphdGlvbi5yZXNvbHZlKGdldERhdGEoKSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGlmIChpc1N5bmNpbmdPbikge1xuICAgICAgICAgICAgICAgICAgICB1bnJlZ2lzdGVyU3Vic2NyaXB0aW9uKCk7XG4gICAgICAgICAgICAgICAgICAgIGlzU3luY2luZ09uID0gZmFsc2U7XG5cbiAgICAgICAgICAgICAgICAgICAgbG9nSW5mbygnU3luYyAnICsgcHVibGljYXRpb24gKyAnIG9mZi4gUGFyYW1zOicgKyBKU09OLnN0cmluZ2lmeShzdWJQYXJhbXMpKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHB1YmxpY2F0aW9uTGlzdGVuZXJPZmYpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHB1YmxpY2F0aW9uTGlzdGVuZXJPZmYoKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHB1YmxpY2F0aW9uTGlzdGVuZXJPZmYgPSBudWxsO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIGlmIChyZWNvbm5lY3RPZmYpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJlY29ubmVjdE9mZigpO1xuICAgICAgICAgICAgICAgICAgICAgICAgcmVjb25uZWN0T2ZmID0gbnVsbDtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gaXNTeW5jaW5nKCkge1xuICAgICAgICAgICAgICAgIHJldHVybiBpc1N5bmNpbmdPbjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gcmVhZHlGb3JMaXN0ZW5pbmcoKSB7XG4gICAgICAgICAgICAgICAgaWYgKCFwdWJsaWNhdGlvbkxpc3RlbmVyT2ZmKSB7XG4gICAgICAgICAgICAgICAgICAgIGxpc3RlbkZvclJlY29ubmVjdGlvblRvUmVzeW5jKCk7XG4gICAgICAgICAgICAgICAgICAgIGxpc3RlblRvUHVibGljYXRpb24oKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogIEJ5IGRlZmF1bHQgdGhlIHJvb3RzY29wZSBpcyBhdHRhY2hlZCBpZiBubyBzY29wZSB3YXMgcHJvdmlkZWQuIEJ1dCBpdCBpcyBwb3NzaWJsZSB0byByZS1hdHRhY2ggaXQgdG8gYSBkaWZmZXJlbnQgc2NvcGUuIGlmIHRoZSBzdWJzY3JpcHRpb24gZGVwZW5kcyBvbiBhIGNvbnRyb2xsZXIuXG4gICAgICAgICAgICAgKlxuICAgICAgICAgICAgICogIERvIG5vdCBhdHRhY2ggYWZ0ZXIgaXQgaGFzIHN5bmNlZC5cbiAgICAgICAgICAgICAqL1xuICAgICAgICAgICAgZnVuY3Rpb24gYXR0YWNoKG5ld1Njb3BlKSB7XG4gICAgICAgICAgICAgICAgaWYgKGRlZmVycmVkSW5pdGlhbGl6YXRpb24pIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgaWYgKGRlc3Ryb3lPZmYpIHtcbiAgICAgICAgICAgICAgICAgICAgZGVzdHJveU9mZigpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBpbm5lclNjb3BlID0gbmV3U2NvcGU7XG4gICAgICAgICAgICAgICAgZGVzdHJveU9mZiA9IGlubmVyU2NvcGUuJG9uKCckZGVzdHJveScsIGRlc3Ryb3kpO1xuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gbGlzdGVuRm9yUmVjb25uZWN0aW9uVG9SZXN5bmMobGlzdGVuTm93KSB7XG4gICAgICAgICAgICAgICAgLy8gZ2l2ZSBhIGNoYW5jZSB0byBjb25uZWN0IGJlZm9yZSBsaXN0ZW5pbmcgdG8gcmVjb25uZWN0aW9uLi4uIEBUT0RPIHNob3VsZCBoYXZlIHVzZXJfcmVjb25uZWN0ZWRfZXZlbnRcbiAgICAgICAgICAgICAgICBzZXRUaW1lb3V0KGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICAgICAgcmVjb25uZWN0T2ZmID0gaW5uZXJTY29wZS4kb24oJ3VzZXJfY29ubmVjdGVkJywgZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgbG9nRGVidWcoJ1Jlc3luY2luZyBhZnRlciBuZXR3b3JrIGxvc3MgdG8gJyArIHB1YmxpY2F0aW9uKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIG5vdGUgdGhlIGJhY2tlbmQgbWlnaHQgcmV0dXJuIGEgbmV3IHN1YnNjcmlwdGlvbiBpZiB0aGUgY2xpZW50IHRvb2sgdG9vIG11Y2ggdGltZSB0byByZWNvbm5lY3QuXG4gICAgICAgICAgICAgICAgICAgICAgICByZWdpc3RlclN1YnNjcmlwdGlvbigpO1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9LCBsaXN0ZW5Ob3cgPyAwIDogMjAwMCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIHJlZ2lzdGVyU3Vic2NyaXB0aW9uKCkge1xuICAgICAgICAgICAgICAgICRzb2NrZXRpby5mZXRjaCgnc3luYy5zdWJzY3JpYmUnLCB7XG4gICAgICAgICAgICAgICAgICAgIHZlcnNpb246IFNZTkNfVkVSU0lPTixcbiAgICAgICAgICAgICAgICAgICAgaWQ6IHN1YnNjcmlwdGlvbklkLCAvLyB0byB0cnkgdG8gcmUtdXNlIGV4aXN0aW5nIHN1YmNyaXB0aW9uXG4gICAgICAgICAgICAgICAgICAgIHB1YmxpY2F0aW9uOiBwdWJsaWNhdGlvbixcbiAgICAgICAgICAgICAgICAgICAgcGFyYW1zOiBzdWJQYXJhbXNcbiAgICAgICAgICAgICAgICB9KS50aGVuKGZ1bmN0aW9uIChzdWJJZCkge1xuICAgICAgICAgICAgICAgICAgICBzdWJzY3JpcHRpb25JZCA9IHN1YklkO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiB1bnJlZ2lzdGVyU3Vic2NyaXB0aW9uKCkge1xuICAgICAgICAgICAgICAgIGlmIChzdWJzY3JpcHRpb25JZCkge1xuICAgICAgICAgICAgICAgICAgICAkc29ja2V0aW8uZmV0Y2goJ3N5bmMudW5zdWJzY3JpYmUnLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICB2ZXJzaW9uOiBTWU5DX1ZFUlNJT04sXG4gICAgICAgICAgICAgICAgICAgICAgICBpZDogc3Vic2NyaXB0aW9uSWRcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIHN1YnNjcmlwdGlvbklkID0gbnVsbDtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIGxpc3RlblRvUHVibGljYXRpb24oKSB7XG4gICAgICAgICAgICAgICAgLy8gY2Fubm90IG9ubHkgbGlzdGVuIHRvIHN1YnNjcmlwdGlvbklkIHlldC4uLmJlY2F1c2UgdGhlIHJlZ2lzdHJhdGlvbiBtaWdodCBoYXZlIGFuc3dlciBwcm92aWRlZCBpdHMgaWQgeWV0Li4uYnV0IHN0YXJ0ZWQgYnJvYWRjYXN0aW5nIGNoYW5nZXMuLi5AVE9ETyBjYW4gYmUgaW1wcm92ZWQuLi5cbiAgICAgICAgICAgICAgICBwdWJsaWNhdGlvbkxpc3RlbmVyT2ZmID0gYWRkUHVibGljYXRpb25MaXN0ZW5lcihwdWJsaWNhdGlvbiwgZnVuY3Rpb24gKGJhdGNoKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChzdWJzY3JpcHRpb25JZCA9PT0gYmF0Y2guc3Vic2NyaXB0aW9uSWQgfHwgKCFzdWJzY3JpcHRpb25JZCAmJiBjaGVja0RhdGFTZXRQYXJhbXNJZk1hdGNoaW5nQmF0Y2hQYXJhbXMoYmF0Y2gucGFyYW1zKSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghYmF0Y2guZGlmZikge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vIENsZWFyIHRoZSBjYWNoZSB0byByZWJ1aWxkIGl0IGlmIGFsbCBkYXRhIHdhcyByZWNlaXZlZC5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWNvcmRTdGF0ZXMgPSB7fTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWlzU2luZ2xlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhY2hlLmxlbmd0aCA9IDA7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgYXBwbHlDaGFuZ2VzKGJhdGNoLnJlY29yZHMpO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFpc0luaXRpYWxQdXNoQ29tcGxldGVkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaXNJbml0aWFsUHVzaENvbXBsZXRlZCA9IHRydWU7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZGVmZXJyZWRJbml0aWFsaXphdGlvbi5yZXNvbHZlKGdldERhdGEoKSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAqIGlmIHRoZSBwYXJhbXMgb2YgdGhlIGRhdGFzZXQgbWF0Y2hlcyB0aGUgbm90aWZpY2F0aW9uLCBpdCBtZWFucyB0aGUgZGF0YSBuZWVkcyB0byBiZSBjb2xsZWN0IHRvIHVwZGF0ZSBhcnJheS5cbiAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBjaGVja0RhdGFTZXRQYXJhbXNJZk1hdGNoaW5nQmF0Y2hQYXJhbXMoYmF0Y2hQYXJhbXMpIHtcbiAgICAgICAgICAgICAgICAvLyBpZiAocGFyYW1zLmxlbmd0aCAhPSBzdHJlYW1QYXJhbXMubGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgLy8gICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgICAgICAvLyB9XG4gICAgICAgICAgICAgICAgaWYgKCFzdWJQYXJhbXMgfHwgT2JqZWN0LmtleXMoc3ViUGFyYW1zKS5sZW5ndGggPT0gMCkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB2YXIgbWF0Y2hpbmcgPSB0cnVlO1xuICAgICAgICAgICAgICAgIGZvciAodmFyIHBhcmFtIGluIGJhdGNoUGFyYW1zKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIGFyZSBvdGhlciBwYXJhbXMgbWF0Y2hpbmc/XG4gICAgICAgICAgICAgICAgICAgIC8vIGV4OiB3ZSBtaWdodCBoYXZlIHJlY2VpdmUgYSBub3RpZmljYXRpb24gYWJvdXQgdGFza0lkPTIwIGJ1dCB0aGlzIHN1YnNjcmlwdGlvbiBhcmUgb25seSBpbnRlcmVzdGVkIGFib3V0IHRhc2tJZC0zXG4gICAgICAgICAgICAgICAgICAgIGlmIChiYXRjaFBhcmFtc1twYXJhbV0gIT09IHN1YlBhcmFtc1twYXJhbV0pIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIG1hdGNoaW5nID0gZmFsc2U7XG4gICAgICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICByZXR1cm4gbWF0Y2hpbmc7XG5cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy8gZmV0Y2ggYWxsIHRoZSBtaXNzaW5nIHJlY29yZHMsIGFuZCBhY3RpdmF0ZSB0aGUgY2FsbCBiYWNrcyAoYWRkLHVwZGF0ZSxyZW1vdmUpIGFjY29yZGluZ2x5IGlmIHRoZXJlIGlzIHNvbWV0aGluZyB0aGF0IGlzIG5ldyBvciBub3QgYWxyZWFkeSBpbiBzeW5jLlxuICAgICAgICAgICAgZnVuY3Rpb24gYXBwbHlDaGFuZ2VzKHJlY29yZHMpIHtcbiAgICAgICAgICAgICAgICB2YXIgbmV3RGF0YUFycmF5ID0gW107XG4gICAgICAgICAgICAgICAgdmFyIG5ld0RhdGE7XG4gICAgICAgICAgICAgICAgc0RzLnJlYWR5ID0gZmFsc2U7XG4gICAgICAgICAgICAgICAgcmVjb3Jkcy5mb3JFYWNoKGZ1bmN0aW9uIChyZWNvcmQpIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gICAgICAgICAgICAgICAgICAgbG9nSW5mbygnRGF0YXN5bmMgWycgKyBkYXRhU3RyZWFtTmFtZSArICddIHJlY2VpdmVkOicgK0pTT04uc3RyaW5naWZ5KHJlY29yZCkpOy8vKyBKU09OLnN0cmluZ2lmeShyZWNvcmQuaWQpKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHJlY29yZC5yZW1vdmUpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJlbW92ZVJlY29yZChyZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKGdldFJlY29yZFN0YXRlKHJlY29yZCkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIGlmIHRoZSByZWNvcmQgaXMgYWxyZWFkeSBwcmVzZW50IGluIHRoZSBjYWNoZS4uLnNvIGl0IGlzIG1pZ2h0YmUgYW4gdXBkYXRlLi5cbiAgICAgICAgICAgICAgICAgICAgICAgIG5ld0RhdGEgPSB1cGRhdGVSZWNvcmQocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIG5ld0RhdGEgPSBhZGRSZWNvcmQocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBpZiAobmV3RGF0YSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgbmV3RGF0YUFycmF5LnB1c2gobmV3RGF0YSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICBzRHMucmVhZHkgPSB0cnVlO1xuICAgICAgICAgICAgICAgIGlmIChpc1NpbmdsZSkge1xuICAgICAgICAgICAgICAgICAgICBzeW5jTGlzdGVuZXIubm90aWZ5KCdyZWFkeScsIGdldERhdGEoKSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3luY0xpc3RlbmVyLm5vdGlmeSgncmVhZHknLCBnZXREYXRhKCksIG5ld0RhdGFBcnJheSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqIEFsdGhvdWdoIG1vc3QgY2FzZXMgYXJlIGhhbmRsZWQgdXNpbmcgb25SZWFkeSwgdGhpcyB0ZWxscyB5b3UgdGhlIGN1cnJlbnQgZGF0YSBzdGF0ZS5cbiAgICAgICAgICAgICAqIFxuICAgICAgICAgICAgICogQHJldHVybnMgaWYgdHJ1ZSBpcyBhIHN5bmMgaGFzIGJlZW4gcHJvY2Vzc2VkIG90aGVyd2lzZSBmYWxzZSBpZiB0aGUgZGF0YSBpcyBub3QgcmVhZHkuXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIGlzUmVhZHkoKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMucmVhZHk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqIFxuICAgICAgICAgICAgICogcmV0dXJucyBhIGZ1bmN0aW9uIHRvIHJlbW92ZSB0aGUgbGlzdGVuZXIuXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIG9uQWRkKGNhbGxiYWNrKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHN5bmNMaXN0ZW5lci5vbignYWRkJywgY2FsbGJhY2spO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqIFxuICAgICAgICAgICAgICogcmV0dXJucyBhIGZ1bmN0aW9uIHRvIHJlbW92ZSB0aGUgbGlzdGVuZXIuXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIG9uVXBkYXRlKGNhbGxiYWNrKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHN5bmNMaXN0ZW5lci5vbigndXBkYXRlJywgY2FsbGJhY2spO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqIFxuICAgICAgICAgICAgICogcmV0dXJucyBhIGZ1bmN0aW9uIHRvIHJlbW92ZSB0aGUgbGlzdGVuZXIuXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIG9uUmVtb3ZlKGNhbGxiYWNrKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHN5bmNMaXN0ZW5lci5vbigncmVtb3ZlJywgY2FsbGJhY2spO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqIFxuICAgICAgICAgICAgICogcmV0dXJucyBhIGZ1bmN0aW9uIHRvIHJlbW92ZSB0aGUgbGlzdGVuZXIuXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIG9uUmVhZHkoY2FsbGJhY2spIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gc3luY0xpc3RlbmVyLm9uKCdyZWFkeScsIGNhbGxiYWNrKTtcbiAgICAgICAgICAgIH1cblxuXG4gICAgICAgICAgICBmdW5jdGlvbiBhZGRSZWNvcmQocmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgbG9nRGVidWcoJ1N5bmMgLT4gSW5zZXJ0ZWQgTmV3IHJlY29yZCAjJyArIEpTT04uc3RyaW5naWZ5KHJlY29yZC5pZCkgKyAnIGZvciBzdWJzY3JpcHRpb24gdG8gJyArIHB1YmxpY2F0aW9uKTsvLyBKU09OLnN0cmluZ2lmeShyZWNvcmQpKTtcbiAgICAgICAgICAgICAgICBnZXRSZXZpc2lvbihyZWNvcmQpOyAvLyBqdXN0IG1ha2Ugc3VyZSB3ZSBjYW4gZ2V0IGEgcmV2aXNpb24gYmVmb3JlIHdlIGhhbmRsZSB0aGlzIHJlY29yZFxuICAgICAgICAgICAgICAgIHVwZGF0ZURhdGFTdG9yYWdlKGZvcm1hdFJlY29yZCA/IGZvcm1hdFJlY29yZChyZWNvcmQpIDogcmVjb3JkKTtcbiAgICAgICAgICAgICAgICBzeW5jTGlzdGVuZXIubm90aWZ5KCdhZGQnLCByZWNvcmQpO1xuICAgICAgICAgICAgICAgIHJldHVybiByZWNvcmQ7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIHVwZGF0ZVJlY29yZChyZWNvcmQpIHtcbiAgICAgICAgICAgICAgICB2YXIgcHJldmlvdXMgPSBnZXRSZWNvcmRTdGF0ZShyZWNvcmQpO1xuICAgICAgICAgICAgICAgIGlmIChnZXRSZXZpc2lvbihyZWNvcmQpIDw9IGdldFJldmlzaW9uKHByZXZpb3VzKSkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgbG9nRGVidWcoJ1N5bmMgLT4gVXBkYXRlZCByZWNvcmQgIycgKyBKU09OLnN0cmluZ2lmeShyZWNvcmQuaWQpICsgJyBmb3Igc3Vic2NyaXB0aW9uIHRvICcgKyBwdWJsaWNhdGlvbik7Ly8gSlNPTi5zdHJpbmdpZnkocmVjb3JkKSk7XG4gICAgICAgICAgICAgICAgdXBkYXRlRGF0YVN0b3JhZ2UoZm9ybWF0UmVjb3JkID8gZm9ybWF0UmVjb3JkKHJlY29yZCkgOiByZWNvcmQpO1xuICAgICAgICAgICAgICAgIHN5bmNMaXN0ZW5lci5ub3RpZnkoJ3VwZGF0ZScsIHJlY29yZCk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlY29yZDtcbiAgICAgICAgICAgIH1cblxuXG4gICAgICAgICAgICBmdW5jdGlvbiByZW1vdmVSZWNvcmQocmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgdmFyIHByZXZpb3VzID0gZ2V0UmVjb3JkU3RhdGUocmVjb3JkKTtcbiAgICAgICAgICAgICAgICBpZiAoIXByZXZpb3VzIHx8IGdldFJldmlzaW9uKHJlY29yZCkgPiBnZXRSZXZpc2lvbihwcmV2aW91cykpIHtcbiAgICAgICAgICAgICAgICAgICAgbG9nRGVidWcoJ1N5bmMgLT4gUmVtb3ZlZCAjJyArIEpTT04uc3RyaW5naWZ5KHJlY29yZC5pZCkgKyAnIGZvciBzdWJzY3JpcHRpb24gdG8gJyArIHB1YmxpY2F0aW9uKTtcbiAgICAgICAgICAgICAgICAgICAgLy8gV2UgY291bGQgaGF2ZSBmb3IgdGhlIHNhbWUgcmVjb3JkIGNvbnNlY3V0aXZlbHkgZmV0Y2hpbmcgaW4gdGhpcyBvcmRlcjpcbiAgICAgICAgICAgICAgICAgICAgLy8gZGVsZXRlIGlkOjQsIHJldiAxMCwgdGhlbiBhZGQgaWQ6NCwgcmV2IDkuLi4uIGJ5IGtlZXBpbmcgdHJhY2sgb2Ygd2hhdCB3YXMgZGVsZXRlZCwgd2Ugd2lsbCBub3QgYWRkIHRoZSByZWNvcmQgc2luY2UgaXQgd2FzIGRlbGV0ZWQgd2l0aCBhIG1vc3QgcmVjZW50IHRpbWVzdGFtcC5cbiAgICAgICAgICAgICAgICAgICAgcmVjb3JkLnJlbW92ZWQgPSB0cnVlOyAvLyBTbyB3ZSBvbmx5IGZsYWcgYXMgcmVtb3ZlZCwgbGF0ZXIgb24gdGhlIGdhcmJhZ2UgY29sbGVjdG9yIHdpbGwgZ2V0IHJpZCBvZiBpdC4gICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgdXBkYXRlRGF0YVN0b3JhZ2UocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgLy8gaWYgdGhlcmUgaXMgbm8gcHJldmlvdXMgcmVjb3JkIHdlIGRvIG5vdCBuZWVkIHRvIHJlbW92ZWQgYW55IHRoaW5nIGZyb20gb3VyIHN0b3JhZ2UuICAgICBcbiAgICAgICAgICAgICAgICAgICAgaWYgKHByZXZpb3VzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBzeW5jTGlzdGVuZXIubm90aWZ5KCdyZW1vdmUnLCByZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICAgICAgZGlzcG9zZShyZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgZnVuY3Rpb24gZGlzcG9zZShyZWNvcmQpIHtcbiAgICAgICAgICAgICAgICAkc3luY0dhcmJhZ2VDb2xsZWN0b3IuZGlzcG9zZShmdW5jdGlvbiBjb2xsZWN0KCkge1xuICAgICAgICAgICAgICAgICAgICB2YXIgZXhpc3RpbmdSZWNvcmQgPSBnZXRSZWNvcmRTdGF0ZShyZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICBpZiAoZXhpc3RpbmdSZWNvcmQgJiYgcmVjb3JkLnJldmlzaW9uID49IGV4aXN0aW5nUmVjb3JkLnJldmlzaW9uXG4gICAgICAgICAgICAgICAgICAgICkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy9sb2dEZWJ1ZygnQ29sbGVjdCBOb3c6JyArIEpTT04uc3RyaW5naWZ5KHJlY29yZCkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgZGVsZXRlIHJlY29yZFN0YXRlc1tnZXRJZFZhbHVlKHJlY29yZC5pZCldO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIGlzRXhpc3RpbmdTdGF0ZUZvcihyZWNvcmQpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gISFnZXRSZWNvcmRTdGF0ZShyZWNvcmQpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBzYXZlUmVjb3JkU3RhdGUocmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgcmVjb3JkU3RhdGVzW2dldElkVmFsdWUocmVjb3JkLmlkKV0gPSByZWNvcmQ7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIGdldFJlY29yZFN0YXRlKHJlY29yZCkge1xuICAgICAgICAgICAgICAgIHJldHVybiByZWNvcmRTdGF0ZXNbZ2V0SWRWYWx1ZShyZWNvcmQuaWQpXTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gdXBkYXRlU3luY2VkT2JqZWN0KHJlY29yZCkge1xuICAgICAgICAgICAgICAgIHNhdmVSZWNvcmRTdGF0ZShyZWNvcmQpO1xuXG4gICAgICAgICAgICAgICAgaWYgKCFyZWNvcmQucmVtb3ZlKSB7XG4gICAgICAgICAgICAgICAgICAgICRzeW5jTWVyZ2UubWVyZ2UoY2FjaGUsIHJlY29yZCwgc3RyaWN0TW9kZSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgJHN5bmNNZXJnZS5jbGVhck9iamVjdChjYWNoZSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiB1cGRhdGVTeW5jZWRBcnJheShyZWNvcmQpIHtcbiAgICAgICAgICAgICAgICB2YXIgZXhpc3RpbmcgPSBnZXRSZWNvcmRTdGF0ZShyZWNvcmQpO1xuICAgICAgICAgICAgICAgIGlmICghZXhpc3RpbmcpIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gYWRkIG5ldyBpbnN0YW5jZVxuICAgICAgICAgICAgICAgICAgICBzYXZlUmVjb3JkU3RhdGUocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFyZWNvcmQucmVtb3ZlZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgY2FjaGUucHVzaChyZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgJHN5bmNNZXJnZS5tZXJnZShleGlzdGluZywgcmVjb3JkLCBzdHJpY3RNb2RlKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHJlY29yZC5yZW1vdmVkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjYWNoZS5zcGxpY2UoY2FjaGUuaW5kZXhPZihleGlzdGluZyksIDEpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBnZXRSZXZpc2lvbihyZWNvcmQpIHtcbiAgICAgICAgICAgICAgICAvLyB3aGF0IHJlc2VydmVkIGZpZWxkIGRvIHdlIHVzZSBhcyB0aW1lc3RhbXBcbiAgICAgICAgICAgICAgICBpZiAoYW5ndWxhci5pc0RlZmluZWQocmVjb3JkLnJldmlzaW9uKSkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gcmVjb3JkLnJldmlzaW9uO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBpZiAoYW5ndWxhci5pc0RlZmluZWQocmVjb3JkLnRpbWVzdGFtcCkpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHJlY29yZC50aW1lc3RhbXA7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignU3luYyByZXF1aXJlcyBhIHJldmlzaW9uIG9yIHRpbWVzdGFtcCBwcm9wZXJ0eSBpbiByZWNlaXZlZCAnICsgKG9iamVjdENsYXNzID8gJ29iamVjdCBbJyArIG9iamVjdENsYXNzLm5hbWUgKyAnXScgOiAncmVjb3JkJykpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqIHRoaXMgb2JqZWN0IFxuICAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gU3luY0xpc3RlbmVyKCkge1xuICAgICAgICAgICAgdmFyIGV2ZW50cyA9IHt9O1xuICAgICAgICAgICAgdmFyIGNvdW50ID0gMDtcblxuICAgICAgICAgICAgdGhpcy5ub3RpZnkgPSBub3RpZnk7XG4gICAgICAgICAgICB0aGlzLm9uID0gb247XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIG5vdGlmeShldmVudCwgZGF0YTEsIGRhdGEyKSB7XG4gICAgICAgICAgICAgICAgdmFyIGxpc3RlbmVycyA9IGV2ZW50c1tldmVudF07XG4gICAgICAgICAgICAgICAgaWYgKGxpc3RlbmVycykge1xuICAgICAgICAgICAgICAgICAgICBfLmZvckVhY2gobGlzdGVuZXJzLCBmdW5jdGlvbiAoY2FsbGJhY2ssIGlkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjYWxsYmFjayhkYXRhMSwgZGF0YTIpO1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogQHJldHVybnMgaGFuZGxlciB0byB1bnJlZ2lzdGVyIGxpc3RlbmVyXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIG9uKGV2ZW50LCBjYWxsYmFjaykge1xuICAgICAgICAgICAgICAgIHZhciBsaXN0ZW5lcnMgPSBldmVudHNbZXZlbnRdO1xuICAgICAgICAgICAgICAgIGlmICghbGlzdGVuZXJzKSB7XG4gICAgICAgICAgICAgICAgICAgIGxpc3RlbmVycyA9IGV2ZW50c1tldmVudF0gPSB7fTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgdmFyIGlkID0gY291bnQrKztcbiAgICAgICAgICAgICAgICBsaXN0ZW5lcnNbaWQrK10gPSBjYWxsYmFjaztcbiAgICAgICAgICAgICAgICByZXR1cm4gZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgICAgICBkZWxldGUgbGlzdGVuZXJzW2lkXTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9O1xuICAgIGZ1bmN0aW9uIGdldElkVmFsdWUoaWQpIHtcbiAgICAgICAgaWYgKCFfLmlzT2JqZWN0KGlkKSkge1xuICAgICAgICAgICAgcmV0dXJuIGlkO1xuICAgICAgICB9XG4gICAgICAgIC8vIGJ1aWxkIGNvbXBvc2l0ZSBrZXkgdmFsdWVcbiAgICAgICAgdmFyIHIgPSBfLmpvaW4oXy5tYXAoaWQsIGZ1bmN0aW9uICh2YWx1ZSkge1xuICAgICAgICAgICAgcmV0dXJuIHZhbHVlO1xuICAgICAgICB9KSwgJ34nKTtcbiAgICAgICAgcmV0dXJuIHI7XG4gICAgfVxuXG5cbiAgICBmdW5jdGlvbiBsb2dJbmZvKG1zZykge1xuICAgICAgICBpZiAoZGVidWcpIHtcbiAgICAgICAgICAgIGNvbnNvbGUuZGVidWcoJ1NZTkMoaW5mbyk6ICcgKyBtc2cpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gbG9nRGVidWcobXNnKSB7XG4gICAgICAgIGlmIChkZWJ1ZyA9PSAyKSB7XG4gICAgICAgICAgICBjb25zb2xlLmRlYnVnKCdTWU5DKGRlYnVnKTogJyArIG1zZyk7XG4gICAgICAgIH1cblxuICAgIH1cblxuXG5cbn07XG59KCkpO1xuIl19
