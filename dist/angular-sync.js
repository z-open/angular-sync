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
                if (isSyncingOn && angular.equals(fetchingParams, subParams)) {
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

//# sourceMappingURL=data:application/json;charset=utf8;base64,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QSxPQUFBLFVBQUE7Z0JBQ0EsSUFBQSxZQUFBLE9BQUE7Z0JBQ0EsSUFBQSxDQUFBLFdBQUE7b0JBQ0EsWUFBQSxPQUFBLFNBQUE7O2dCQUVBLElBQUEsS0FBQTtnQkFDQSxVQUFBLFFBQUE7Z0JBQ0EsT0FBQSxZQUFBO29CQUNBLE9BQUEsVUFBQTs7Ozs7SUFLQSxTQUFBLFdBQUEsSUFBQTtRQUNBLElBQUEsQ0FBQSxFQUFBLFNBQUEsS0FBQTtZQUNBLE9BQUE7OztRQUdBLElBQUEsSUFBQSxFQUFBLEtBQUEsRUFBQSxJQUFBLElBQUEsVUFBQSxPQUFBO1lBQ0EsT0FBQTtZQUNBO1FBQ0EsT0FBQTs7OztJQUlBLFNBQUEsUUFBQSxLQUFBO1FBQ0EsSUFBQSxPQUFBO1lBQ0EsUUFBQSxNQUFBLGlCQUFBOzs7O0lBSUEsU0FBQSxTQUFBLEtBQUE7UUFDQSxJQUFBLFNBQUEsR0FBQTtZQUNBLFFBQUEsTUFBQSxrQkFBQTs7Ozs7OztDQU9BOztBQUVBIiwiZmlsZSI6ImFuZ3VsYXItc3luYy5qcyIsInNvdXJjZXNDb250ZW50IjpbIihmdW5jdGlvbigpIHtcblwidXNlIHN0cmljdFwiO1xuXG5hbmd1bGFyXG4gICAgLm1vZHVsZSgnc3luYycsIFsnc29ja2V0aW8tYXV0aCddKTtcbn0oKSk7XG5cbihmdW5jdGlvbigpIHtcblwidXNlIHN0cmljdFwiO1xuXG5hbmd1bGFyXG4gICAgLm1vZHVsZSgnc3luYycpXG4gICAgLmZhY3RvcnkoJyRzeW5jR2FyYmFnZUNvbGxlY3RvcicsIHN5bmNHYXJiYWdlQ29sbGVjdG9yKTtcblxuLyoqXG4gKiBzYWZlbHkgcmVtb3ZlIGRlbGV0ZWQgcmVjb3JkL29iamVjdCBmcm9tIG1lbW9yeSBhZnRlciB0aGUgc3luYyBwcm9jZXNzIGRpc3Bvc2VkIHRoZW0uXG4gKiBcbiAqIFRPRE86IFNlY29uZHMgc2hvdWxkIHJlZmxlY3QgdGhlIG1heCB0aW1lICB0aGF0IHN5bmMgY2FjaGUgaXMgdmFsaWQgKG5ldHdvcmsgbG9zcyB3b3VsZCBmb3JjZSBhIHJlc3luYyksIHdoaWNoIHNob3VsZCBtYXRjaCBtYXhEaXNjb25uZWN0aW9uVGltZUJlZm9yZURyb3BwaW5nU3Vic2NyaXB0aW9uIG9uIHRoZSBzZXJ2ZXIgc2lkZS5cbiAqIFxuICogTm90ZTpcbiAqIHJlbW92ZWQgcmVjb3JkIHNob3VsZCBiZSBkZWxldGVkIGZyb20gdGhlIHN5bmMgaW50ZXJuYWwgY2FjaGUgYWZ0ZXIgYSB3aGlsZSBzbyB0aGF0IHRoZXkgZG8gbm90IHN0YXkgaW4gdGhlIG1lbW9yeS4gVGhleSBjYW5ub3QgYmUgcmVtb3ZlZCB0b28gZWFybHkgYXMgYW4gb2xkZXIgdmVyc2lvbi9zdGFtcCBvZiB0aGUgcmVjb3JkIGNvdWxkIGJlIHJlY2VpdmVkIGFmdGVyIGl0cyByZW1vdmFsLi4ud2hpY2ggd291bGQgcmUtYWRkIHRvIGNhY2hlLi4uZHVlIGFzeW5jaHJvbm91cyBwcm9jZXNzaW5nLi4uXG4gKi9cbmZ1bmN0aW9uIHN5bmNHYXJiYWdlQ29sbGVjdG9yKCkge1xuICAgIHZhciBpdGVtcyA9IFtdO1xuICAgIHZhciBzZWNvbmRzID0gMjtcbiAgICB2YXIgc2NoZWR1bGVkID0gZmFsc2U7XG5cbiAgICB2YXIgc2VydmljZSA9IHtcbiAgICAgICAgc2V0U2Vjb25kczogc2V0U2Vjb25kcyxcbiAgICAgICAgZ2V0U2Vjb25kczogZ2V0U2Vjb25kcyxcbiAgICAgICAgZGlzcG9zZTogZGlzcG9zZSxcbiAgICAgICAgc2NoZWR1bGU6IHNjaGVkdWxlLFxuICAgICAgICBydW46IHJ1bixcbiAgICAgICAgZ2V0SXRlbUNvdW50OiBnZXRJdGVtQ291bnRcbiAgICB9O1xuXG4gICAgcmV0dXJuIHNlcnZpY2U7XG5cbiAgICAvLy8vLy8vLy8vXG5cbiAgICBmdW5jdGlvbiBzZXRTZWNvbmRzKHZhbHVlKSB7XG4gICAgICAgIHNlY29uZHMgPSB2YWx1ZTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBnZXRTZWNvbmRzKCkge1xuICAgICAgICByZXR1cm4gc2Vjb25kcztcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBnZXRJdGVtQ291bnQoKSB7XG4gICAgICAgIHJldHVybiBpdGVtcy5sZW5ndGg7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gZGlzcG9zZShjb2xsZWN0KSB7XG4gICAgICAgIGl0ZW1zLnB1c2goe1xuICAgICAgICAgICAgdGltZXN0YW1wOiBEYXRlLm5vdygpLFxuICAgICAgICAgICAgY29sbGVjdDogY29sbGVjdFxuICAgICAgICB9KTtcbiAgICAgICAgaWYgKCFzY2hlZHVsZWQpIHtcbiAgICAgICAgICAgIHNlcnZpY2Uuc2NoZWR1bGUoKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGZ1bmN0aW9uIHNjaGVkdWxlKCkge1xuICAgICAgICBpZiAoIXNlY29uZHMpIHtcbiAgICAgICAgICAgIHNlcnZpY2UucnVuKCk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgc2NoZWR1bGVkID0gdHJ1ZTtcbiAgICAgICAgc2V0VGltZW91dChmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICBzZXJ2aWNlLnJ1bigpO1xuICAgICAgICAgICAgaWYgKGl0ZW1zLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgICAgICBzY2hlZHVsZSgpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBzY2hlZHVsZWQgPSBmYWxzZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSwgc2Vjb25kcyAqIDEwMDApO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIHJ1bigpIHtcbiAgICAgICAgdmFyIHRpbWVvdXQgPSBEYXRlLm5vdygpIC0gc2Vjb25kcyAqIDEwMDA7XG4gICAgICAgIHdoaWxlIChpdGVtcy5sZW5ndGggPiAwICYmIGl0ZW1zWzBdLnRpbWVzdGFtcCA8PSB0aW1lb3V0KSB7XG4gICAgICAgICAgICBpdGVtcy5zaGlmdCgpLmNvbGxlY3QoKTtcbiAgICAgICAgfVxuICAgIH1cbn1cbn0oKSk7XG5cbihmdW5jdGlvbigpIHtcblwidXNlIHN0cmljdFwiO1xuXG5hbmd1bGFyXG4gICAgLm1vZHVsZSgnc3luYycpXG4gICAgLmZhY3RvcnkoJyRzeW5jTWVyZ2UnLCBzeW5jTWVyZ2UpO1xuXG5mdW5jdGlvbiBzeW5jTWVyZ2UoKSB7XG5cbiAgICByZXR1cm4ge1xuICAgICAgICBtZXJnZTogbWVyZ2VPYmplY3QsXG4gICAgICAgIGNsZWFyT2JqZWN0OiBjbGVhck9iamVjdFxuICAgIH1cblxuXG4gICAgLyoqIG1lcmdlIGFuIG9iamVjdCB3aXRoIGFuIG90aGVyLiBNZXJnZSBhbHNvIGlubmVyIG9iamVjdHMgYW5kIG9iamVjdHMgaW4gYXJyYXkuIFxuICAgICAqIFJlZmVyZW5jZSB0byB0aGUgb3JpZ2luYWwgb2JqZWN0cyBhcmUgbWFpbnRhaW5lZCBpbiB0aGUgZGVzdGluYXRpb24gb2JqZWN0LlxuICAgICAqIE9ubHkgY29udGVudCBpcyB1cGRhdGVkLlxuICAgICAqXG4gICAgICpAcGFyYW0gPG9iamVjdD4gZGVzdGluYXRpb24gIG9iamVjdCB0byBtZXJnZSBpbnRvXG4gICAgICpAcGFyYW0gPG9iamVjdD4gZGVzdGluYXRpb24gIG9iamVjdCB0byBtZXJnZSBpbnRvXG4gICAgICpAcGFyYW0gPGJvb2xlYW4+IGlzU3RyaWN0TW9kZSBkZWZhdWx0IGZhbHNlLCBpZiB0cnVlIHdvdWxkIGdlbmVyYXRlIGFuIGVycm9yIGlmIGlubmVyIG9iamVjdHMgaW4gYXJyYXkgZG8gbm90IGhhdmUgaWQgZmllbGRcbiAgICAgKi9cbiAgICBmdW5jdGlvbiBtZXJnZU9iamVjdChkZXN0aW5hdGlvbiwgc291cmNlLCBpc1N0cmljdE1vZGUpIHtcbiAgICAgICAgaWYgKCFkZXN0aW5hdGlvbikge1xuICAgICAgICAgICAgcmV0dXJuIHNvdXJjZTsvLyBfLmFzc2lnbih7fSwgc291cmNlKTs7XG4gICAgICAgIH1cbiAgICAgICAgLy8gY3JlYXRlIG5ldyBvYmplY3QgY29udGFpbmluZyBvbmx5IHRoZSBwcm9wZXJ0aWVzIG9mIHNvdXJjZSBtZXJnZSB3aXRoIGRlc3RpbmF0aW9uXG4gICAgICAgIHZhciBvYmplY3QgPSB7fTtcbiAgICAgICAgZm9yICh2YXIgcHJvcGVydHkgaW4gc291cmNlKSB7XG4gICAgICAgICAgICBpZiAoXy5pc0FycmF5KHNvdXJjZVtwcm9wZXJ0eV0pKSB7XG4gICAgICAgICAgICAgICAgb2JqZWN0W3Byb3BlcnR5XSA9IG1lcmdlQXJyYXkoZGVzdGluYXRpb25bcHJvcGVydHldLCBzb3VyY2VbcHJvcGVydHldLCBpc1N0cmljdE1vZGUpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChfLmlzRnVuY3Rpb24oc291cmNlW3Byb3BlcnR5XSkpIHtcbiAgICAgICAgICAgICAgICBvYmplY3RbcHJvcGVydHldID0gc291cmNlW3Byb3BlcnR5XTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoXy5pc09iamVjdChzb3VyY2VbcHJvcGVydHldKSkge1xuICAgICAgICAgICAgICAgIG9iamVjdFtwcm9wZXJ0eV0gPSBtZXJnZU9iamVjdChkZXN0aW5hdGlvbltwcm9wZXJ0eV0sIHNvdXJjZVtwcm9wZXJ0eV0sIGlzU3RyaWN0TW9kZSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIG9iamVjdFtwcm9wZXJ0eV0gPSBzb3VyY2VbcHJvcGVydHldO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgY2xlYXJPYmplY3QoZGVzdGluYXRpb24pO1xuICAgICAgICBfLmFzc2lnbihkZXN0aW5hdGlvbiwgb2JqZWN0KTtcblxuICAgICAgICByZXR1cm4gZGVzdGluYXRpb247XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gbWVyZ2VBcnJheShkZXN0aW5hdGlvbiwgc291cmNlLCBpc1N0cmljdE1vZGUpIHtcbiAgICAgICAgaWYgKCFkZXN0aW5hdGlvbikge1xuICAgICAgICAgICAgcmV0dXJuIHNvdXJjZTtcbiAgICAgICAgfVxuICAgICAgICB2YXIgYXJyYXkgPSBbXTtcbiAgICAgICAgc291cmNlLmZvckVhY2goZnVuY3Rpb24gKGl0ZW0pIHtcbiAgICAgICAgICAgIC8vIGRvZXMgbm90IHRyeSB0byBtYWludGFpbiBvYmplY3QgcmVmZXJlbmNlcyBpbiBhcnJheXNcbiAgICAgICAgICAgIC8vIHN1cGVyIGxvb3NlIG1vZGUuXG4gICAgICAgICAgICBpZiAoaXNTdHJpY3RNb2RlPT09J05PTkUnKSB7XG4gICAgICAgICAgICAgICAgYXJyYXkucHVzaChpdGVtKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgLy8gb2JqZWN0IGluIGFycmF5IG11c3QgaGF2ZSBhbiBpZCBvdGhlcndpc2Ugd2UgY2FuJ3QgbWFpbnRhaW4gdGhlIGluc3RhbmNlIHJlZmVyZW5jZVxuICAgICAgICAgICAgICAgIGlmICghXy5pc0FycmF5KGl0ZW0pICYmIF8uaXNPYmplY3QoaXRlbSkpIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gbGV0IHRyeSB0byBmaW5kIHRoZSBpbnN0YW5jZVxuICAgICAgICAgICAgICAgICAgICBpZiAoYW5ndWxhci5pc0RlZmluZWQoaXRlbS5pZCkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGFycmF5LnB1c2gobWVyZ2VPYmplY3QoXy5maW5kKGRlc3RpbmF0aW9uLCBmdW5jdGlvbiAob2JqKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIG9iai5pZC50b1N0cmluZygpID09PSBpdGVtLmlkLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9KSwgaXRlbSwgaXNTdHJpY3RNb2RlKSk7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoaXNTdHJpY3RNb2RlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdvYmplY3RzIGluIGFycmF5IG11c3QgaGF2ZSBhbiBpZCBvdGhlcndpc2Ugd2UgY2FuXFwndCBtYWludGFpbiB0aGUgaW5zdGFuY2UgcmVmZXJlbmNlLiAnICsgSlNPTi5zdHJpbmdpZnkoaXRlbSkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgYXJyYXkucHVzaChpdGVtKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGFycmF5LnB1c2goaXRlbSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICBkZXN0aW5hdGlvbi5sZW5ndGggPSAwO1xuICAgICAgICBBcnJheS5wcm90b3R5cGUucHVzaC5hcHBseShkZXN0aW5hdGlvbiwgYXJyYXkpO1xuICAgICAgICAvL2FuZ3VsYXIuY29weShkZXN0aW5hdGlvbiwgYXJyYXkpO1xuICAgICAgICByZXR1cm4gZGVzdGluYXRpb247XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gY2xlYXJPYmplY3Qob2JqZWN0KSB7XG4gICAgICAgIE9iamVjdC5rZXlzKG9iamVjdCkuZm9yRWFjaChmdW5jdGlvbiAoa2V5KSB7IGRlbGV0ZSBvYmplY3Rba2V5XTsgfSk7XG4gICAgfVxufTtcbn0oKSk7XG5cbihmdW5jdGlvbigpIHtcblwidXNlIHN0cmljdFwiO1xuXG4vKipcbiAqIFxuICogU2VydmljZSB0aGF0IGFsbG93cyBhbiBhcnJheSBvZiBkYXRhIHJlbWFpbiBpbiBzeW5jIHdpdGggYmFja2VuZC5cbiAqIFxuICogXG4gKiBleDpcbiAqIHdoZW4gdGhlcmUgaXMgYSBub3RpZmljYXRpb24sIG5vdGljYXRpb25TZXJ2aWNlIG5vdGlmaWVzIHRoYXQgdGhlcmUgaXMgc29tZXRoaW5nIG5ldy4uLnRoZW4gdGhlIGRhdGFzZXQgZ2V0IHRoZSBkYXRhIGFuZCBub3RpZmllcyBhbGwgaXRzIGNhbGxiYWNrLlxuICogXG4gKiBOT1RFOiBcbiAqICBcbiAqIFxuICogUHJlLVJlcXVpc3RlOlxuICogLS0tLS0tLS0tLS0tLVxuICogU3luYyBkb2VzIG5vdCB3b3JrIGlmIG9iamVjdHMgZG8gbm90IGhhdmUgQk9USCBpZCBhbmQgcmV2aXNpb24gZmllbGQhISEhXG4gKiBcbiAqIFdoZW4gdGhlIGJhY2tlbmQgd3JpdGVzIGFueSBkYXRhIHRvIHRoZSBkYiB0aGF0IGFyZSBzdXBwb3NlZCB0byBiZSBzeW5jcm9uaXplZDpcbiAqIEl0IG11c3QgbWFrZSBzdXJlIGVhY2ggYWRkLCB1cGRhdGUsIHJlbW92YWwgb2YgcmVjb3JkIGlzIHRpbWVzdGFtcGVkLlxuICogSXQgbXVzdCBub3RpZnkgdGhlIGRhdGFzdHJlYW0gKHdpdGggbm90aWZ5Q2hhbmdlIG9yIG5vdGlmeVJlbW92YWwpIHdpdGggc29tZSBwYXJhbXMgc28gdGhhdCBiYWNrZW5kIGtub3dzIHRoYXQgaXQgaGFzIHRvIHB1c2ggYmFjayB0aGUgZGF0YSBiYWNrIHRvIHRoZSBzdWJzY3JpYmVycyAoZXg6IHRoZSB0YXNrQ3JlYXRpb24gd291bGQgbm90aWZ5IHdpdGggaXRzIHBsYW5JZClcbiogXG4gKiBcbiAqL1xuYW5ndWxhclxuICAgIC5tb2R1bGUoJ3N5bmMnKVxuICAgIC5wcm92aWRlcignJHN5bmMnLCBzeW5jUHJvdmlkZXIpO1xuXG5mdW5jdGlvbiBzeW5jUHJvdmlkZXIoKSB7XG5cbiAgICB2YXIgZGVidWc7XG5cbiAgICB0aGlzLnNldERlYnVnID0gZnVuY3Rpb24gKHZhbHVlKSB7XG4gICAgICAgIGRlYnVnID0gdmFsdWU7XG4gICAgfTtcblxuICAgIHRoaXMuJGdldCA9IGZ1bmN0aW9uIHN5bmMoJHJvb3RTY29wZSwgJHEsICRzb2NrZXRpbywgJHN5bmNHYXJiYWdlQ29sbGVjdG9yLCAkc3luY01lcmdlKSB7XG5cbiAgICAgICAgdmFyIHB1YmxpY2F0aW9uTGlzdGVuZXJzID0ge30sXG4gICAgICAgICAgICBwdWJsaWNhdGlvbkxpc3RlbmVyQ291bnQgPSAwO1xuICAgICAgICB2YXIgR1JBQ0VfUEVSSU9EX0lOX1NFQ09ORFMgPSA4O1xuICAgICAgICB2YXIgU1lOQ19WRVJTSU9OID0gJzEuMic7XG5cblxuICAgICAgICBsaXN0ZW5Ub1N5bmNOb3RpZmljYXRpb24oKTtcblxuICAgICAgICB2YXIgc2VydmljZSA9IHtcbiAgICAgICAgICAgIHN1YnNjcmliZTogc3Vic2NyaWJlLFxuICAgICAgICAgICAgcmVzb2x2ZVN1YnNjcmlwdGlvbjogcmVzb2x2ZVN1YnNjcmlwdGlvbixcbiAgICAgICAgICAgIGdldEdyYWNlUGVyaW9kOiBnZXRHcmFjZVBlcmlvZCxcbiAgICAgICAgICAgIGdldElkVmFsdWU6IGdldElkVmFsdWVcbiAgICAgICAgfTtcblxuICAgICAgICByZXR1cm4gc2VydmljZTtcblxuICAgICAgICAvLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vL1xuICAgICAgICAvKipcbiAgICAgICAgICogc3Vic2NyaWJlIHRvIHB1YmxpY2F0aW9uIGFuZCByZXR1cm5zIHRoZSBzdWJzY3JpcHRpb24gd2hlbiBkYXRhIGlzIGF2YWlsYWJsZS4gXG4gICAgICAgICAqIEBwYXJhbSBwdWJsaWNhdGlvbiBuYW1lLiBvbiB0aGUgc2VydmVyIHNpZGUsIGEgcHVibGljYXRpb24gc2hhbGwgZXhpc3QuIGV4OiBtYWdhemluZXMuc3luY1xuICAgICAgICAgKiBAcGFyYW0gcGFyYW1zICAgdGhlIHBhcmFtcyBvYmplY3QgcGFzc2VkIHRvIHRoZSBzdWJzY3JpcHRpb24sIGV4OiB7bWFnYXppbmVJZDonZW50cmVwcmVuZXVyJ30pXG4gICAgICAgICAqIEBwYXJhbSBvYmplY3RDbGFzcyBhbiBpbnN0YW5jZSBvZiB0aGlzIGNsYXNzIHdpbGwgYmUgY3JlYXRlZCBmb3IgZWFjaCByZWNvcmQgcmVjZWl2ZWQuXG4gICAgICAgICAqIHJldHVybnMgYSBwcm9taXNlIHJldHVybmluZyB0aGUgc3Vic2NyaXB0aW9uIHdoZW4gdGhlIGRhdGEgaXMgc3luY2VkXG4gICAgICAgICAqIG9yIHJlamVjdHMgaWYgdGhlIGluaXRpYWwgc3luYyBmYWlscyB0byBjb21wbGV0ZSBpbiBhIGxpbWl0ZWQgYW1vdW50IG9mIHRpbWUuIFxuICAgICAgICAgKiBcbiAgICAgICAgICogdG8gZ2V0IHRoZSBkYXRhIGZyb20gdGhlIGRhdGFTZXQsIGp1c3QgZGF0YVNldC5nZXREYXRhKClcbiAgICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIHJlc29sdmVTdWJzY3JpcHRpb24ocHVibGljYXRpb25OYW1lLCBwYXJhbXMsIG9iamVjdENsYXNzKSB7XG4gICAgICAgICAgICB2YXIgZGVmZXJyZWQgPSAkcS5kZWZlcigpO1xuICAgICAgICAgICAgdmFyIHNEcyA9IHN1YnNjcmliZShwdWJsaWNhdGlvbk5hbWUpLnNldE9iamVjdENsYXNzKG9iamVjdENsYXNzKTtcblxuICAgICAgICAgICAgLy8gZ2l2ZSBhIGxpdHRsZSB0aW1lIGZvciBzdWJzY3JpcHRpb24gdG8gZmV0Y2ggdGhlIGRhdGEuLi5vdGhlcndpc2UgZ2l2ZSB1cCBzbyB0aGF0IHdlIGRvbid0IGdldCBzdHVjayBpbiBhIHJlc29sdmUgd2FpdGluZyBmb3JldmVyLlxuICAgICAgICAgICAgdmFyIGdyYWNlUGVyaW9kID0gc2V0VGltZW91dChmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgaWYgKCFzRHMucmVhZHkpIHtcbiAgICAgICAgICAgICAgICAgICAgc0RzLmRlc3Ryb3koKTtcbiAgICAgICAgICAgICAgICAgICAgbG9nSW5mbygnQXR0ZW1wdCB0byBzdWJzY3JpYmUgdG8gcHVibGljYXRpb24gJyArIHB1YmxpY2F0aW9uTmFtZSArICcgZmFpbGVkJyk7XG4gICAgICAgICAgICAgICAgICAgIGRlZmVycmVkLnJlamVjdCgnU1lOQ19USU1FT1VUJyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSwgR1JBQ0VfUEVSSU9EX0lOX1NFQ09ORFMgKiAxMDAwKTtcblxuICAgICAgICAgICAgc0RzLnNldFBhcmFtZXRlcnMocGFyYW1zKVxuICAgICAgICAgICAgICAgIC53YWl0Rm9yRGF0YVJlYWR5KClcbiAgICAgICAgICAgICAgICAudGhlbihmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgICAgIGNsZWFyVGltZW91dChncmFjZVBlcmlvZCk7XG4gICAgICAgICAgICAgICAgICAgIGRlZmVycmVkLnJlc29sdmUoc0RzKTtcbiAgICAgICAgICAgICAgICB9KS5jYXRjaChmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgICAgIGNsZWFyVGltZW91dChncmFjZVBlcmlvZCk7XG4gICAgICAgICAgICAgICAgICAgIHNEcy5kZXN0cm95KCk7XG4gICAgICAgICAgICAgICAgICAgIGRlZmVycmVkLnJlamVjdCgnRmFpbGVkIHRvIHN1YnNjcmliZSB0byBwdWJsaWNhdGlvbiAnICsgcHVibGljYXRpb25OYW1lICsgJyBmYWlsZWQnKTtcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIHJldHVybiBkZWZlcnJlZC5wcm9taXNlO1xuICAgICAgICB9XG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqIFxuICAgICAgICAgKiBmb3IgdGVzdCBwdXJwb3NlcywgcmV0dXJucyB0aGUgdGltZSByZXNvbHZlU3Vic2NyaXB0aW9uIGJlZm9yZSBpdCB0aW1lcyBvdXQuXG4gICAgICAgICAqL1xuICAgICAgICBmdW5jdGlvbiBnZXRHcmFjZVBlcmlvZCgpIHtcbiAgICAgICAgICAgIHJldHVybiBHUkFDRV9QRVJJT0RfSU5fU0VDT05EUztcbiAgICAgICAgfVxuICAgICAgICAvKipcbiAgICAgICAgICogc3Vic2NyaWJlIHRvIHB1YmxpY2F0aW9uLiBJdCB3aWxsIG5vdCBzeW5jIHVudGlsIHlvdSBzZXQgdGhlIHBhcmFtcy5cbiAgICAgICAgICogXG4gICAgICAgICAqIEBwYXJhbSBwdWJsaWNhdGlvbiBuYW1lLiBvbiB0aGUgc2VydmVyIHNpZGUsIGEgcHVibGljYXRpb24gc2hhbGwgZXhpc3QuIGV4OiBtYWdhemluZXMuc3luY1xuICAgICAgICAgKiBAcGFyYW0gcGFyYW1zICAgdGhlIHBhcmFtcyBvYmplY3QgcGFzc2VkIHRvIHRoZSBzdWJzY3JpcHRpb24sIGV4OiB7bWFnYXppbmVJZDonZW50cmVwcmVuZXVyJ30pXG4gICAgICAgICAqIHJldHVybnMgc3Vic2NyaXB0aW9uXG4gICAgICAgICAqIFxuICAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gc3Vic2NyaWJlKHB1YmxpY2F0aW9uTmFtZSwgc2NvcGUpIHtcbiAgICAgICAgICAgIHJldHVybiBuZXcgU3Vic2NyaXB0aW9uKHB1YmxpY2F0aW9uTmFtZSwgc2NvcGUpO1xuICAgICAgICB9XG5cblxuXG4gICAgICAgIC8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vXG4gICAgICAgIC8vIEhFTFBFUlNcblxuICAgICAgICAvLyBldmVyeSBzeW5jIG5vdGlmaWNhdGlvbiBjb21lcyB0aHJ1IHRoZSBzYW1lIGV2ZW50IHRoZW4gaXQgaXMgZGlzcGF0Y2hlcyB0byB0aGUgdGFyZ2V0ZWQgc3Vic2NyaXB0aW9ucy5cbiAgICAgICAgZnVuY3Rpb24gbGlzdGVuVG9TeW5jTm90aWZpY2F0aW9uKCkge1xuICAgICAgICAgICAgJHNvY2tldGlvLm9uKCdTWU5DX05PVycsIGZ1bmN0aW9uIChzdWJOb3RpZmljYXRpb24sIGZuKSB7XG4gICAgICAgICAgICAgICAgbG9nSW5mbygnU3luY2luZyB3aXRoIHN1YnNjcmlwdGlvbiBbbmFtZTonICsgc3ViTm90aWZpY2F0aW9uLm5hbWUgKyAnLCBpZDonICsgc3ViTm90aWZpY2F0aW9uLnN1YnNjcmlwdGlvbklkICsgJyAsIHBhcmFtczonICsgSlNPTi5zdHJpbmdpZnkoc3ViTm90aWZpY2F0aW9uLnBhcmFtcykgKyAnXS4gUmVjb3JkczonICsgc3ViTm90aWZpY2F0aW9uLnJlY29yZHMubGVuZ3RoICsgJ1snICsgKHN1Yk5vdGlmaWNhdGlvbi5kaWZmID8gJ0RpZmYnIDogJ0FsbCcpICsgJ10nKTtcbiAgICAgICAgICAgICAgICB2YXIgbGlzdGVuZXJzID0gcHVibGljYXRpb25MaXN0ZW5lcnNbc3ViTm90aWZpY2F0aW9uLm5hbWVdO1xuICAgICAgICAgICAgICAgIGlmIChsaXN0ZW5lcnMpIHtcbiAgICAgICAgICAgICAgICAgICAgZm9yICh2YXIgbGlzdGVuZXIgaW4gbGlzdGVuZXJzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsaXN0ZW5lcnNbbGlzdGVuZXJdKHN1Yk5vdGlmaWNhdGlvbik7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgZm4oJ1NZTkNFRCcpOyAvLyBsZXQga25vdyB0aGUgYmFja2VuZCB0aGUgY2xpZW50IHdhcyBhYmxlIHRvIHN5bmMuXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfTtcblxuXG4gICAgICAgIC8vIHRoaXMgYWxsb3dzIGEgZGF0YXNldCB0byBsaXN0ZW4gdG8gYW55IFNZTkNfTk9XIGV2ZW50Li5hbmQgaWYgdGhlIG5vdGlmaWNhdGlvbiBpcyBhYm91dCBpdHMgZGF0YS5cbiAgICAgICAgZnVuY3Rpb24gYWRkUHVibGljYXRpb25MaXN0ZW5lcihzdHJlYW1OYW1lLCBjYWxsYmFjaykge1xuICAgICAgICAgICAgdmFyIHVpZCA9IHB1YmxpY2F0aW9uTGlzdGVuZXJDb3VudCsrO1xuICAgICAgICAgICAgdmFyIGxpc3RlbmVycyA9IHB1YmxpY2F0aW9uTGlzdGVuZXJzW3N0cmVhbU5hbWVdO1xuICAgICAgICAgICAgaWYgKCFsaXN0ZW5lcnMpIHtcbiAgICAgICAgICAgICAgICBwdWJsaWNhdGlvbkxpc3RlbmVyc1tzdHJlYW1OYW1lXSA9IGxpc3RlbmVycyA9IHt9O1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgbGlzdGVuZXJzW3VpZF0gPSBjYWxsYmFjaztcblxuICAgICAgICAgICAgcmV0dXJuIGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICBkZWxldGUgbGlzdGVuZXJzW3VpZF07XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gICAgICAgIC8vIFN1YnNjcmlwdGlvbiBvYmplY3RcbiAgICAgICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gICAgICAgIC8qKlxuICAgICAgICAgKiBhIHN1YnNjcmlwdGlvbiBzeW5jaHJvbml6ZXMgd2l0aCB0aGUgYmFja2VuZCBmb3IgYW55IGJhY2tlbmQgZGF0YSBjaGFuZ2UgYW5kIG1ha2VzIHRoYXQgZGF0YSBhdmFpbGFibGUgdG8gYSBjb250cm9sbGVyLlxuICAgICAgICAgKiBcbiAgICAgICAgICogIFdoZW4gY2xpZW50IHN1YnNjcmliZXMgdG8gYW4gc3luY3Jvbml6ZWQgYXBpLCBhbnkgZGF0YSBjaGFuZ2UgdGhhdCBpbXBhY3RzIHRoZSBhcGkgcmVzdWx0IFdJTEwgYmUgUFVTSGVkIHRvIHRoZSBjbGllbnQuXG4gICAgICAgICAqIElmIHRoZSBjbGllbnQgZG9lcyBOT1Qgc3Vic2NyaWJlIG9yIHN0b3Agc3Vic2NyaWJlLCBpdCB3aWxsIG5vIGxvbmdlciByZWNlaXZlIHRoZSBQVVNILiBcbiAgICAgICAgICogICAgXG4gICAgICAgICAqIGlmIHRoZSBjb25uZWN0aW9uIGlzIGxvc3QgZm9yIGEgc2hvcnQgdGltZSAoZHVyYXRpb24gZGVmaW5lZCBvbiBzZXJ2ZXItc2lkZSksIHRoZSBzZXJ2ZXIgcXVldWVzIHRoZSBjaGFuZ2VzIGlmIGFueS4gXG4gICAgICAgICAqIFdoZW4gdGhlIGNvbm5lY3Rpb24gcmV0dXJucywgdGhlIG1pc3NpbmcgZGF0YSBhdXRvbWF0aWNhbGx5ICB3aWxsIGJlIFBVU0hlZCB0byB0aGUgc3Vic2NyaWJpbmcgY2xpZW50LlxuICAgICAgICAgKiBpZiB0aGUgY29ubmVjdGlvbiBpcyBsb3N0IGZvciBhIGxvbmcgdGltZSAoZHVyYXRpb24gZGVmaW5lZCBvbiB0aGUgc2VydmVyKSwgdGhlIHNlcnZlciB3aWxsIGRlc3Ryb3kgdGhlIHN1YnNjcmlwdGlvbi4gVG8gc2ltcGxpZnksIHRoZSBjbGllbnQgd2lsbCByZXN1YnNjcmliZSBhdCBpdHMgcmVjb25uZWN0aW9uIGFuZCBnZXQgYWxsIGRhdGEuXG4gICAgICAgICAqIFxuICAgICAgICAgKiBzdWJzY3JpcHRpb24gb2JqZWN0IHByb3ZpZGVzIDMgY2FsbGJhY2tzIChhZGQsdXBkYXRlLCBkZWwpIHdoaWNoIGFyZSBjYWxsZWQgZHVyaW5nIHN5bmNocm9uaXphdGlvbi5cbiAgICAgICAgICogICAgICBcbiAgICAgICAgICogU2NvcGUgd2lsbCBhbGxvdyB0aGUgc3Vic2NyaXB0aW9uIHN0b3Agc3luY2hyb25pemluZyBhbmQgY2FuY2VsIHJlZ2lzdHJhdGlvbiB3aGVuIGl0IGlzIGRlc3Ryb3llZC4gXG4gICAgICAgICAqICBcbiAgICAgICAgICogQ29uc3RydWN0b3I6XG4gICAgICAgICAqIFxuICAgICAgICAgKiBAcGFyYW0gcHVibGljYXRpb24sIHRoZSBwdWJsaWNhdGlvbiBtdXN0IGV4aXN0IG9uIHRoZSBzZXJ2ZXIgc2lkZVxuICAgICAgICAgKiBAcGFyYW0gc2NvcGUsIGJ5IGRlZmF1bHQgJHJvb3RTY29wZSwgYnV0IGNhbiBiZSBtb2RpZmllZCBsYXRlciBvbiB3aXRoIGF0dGFjaCBtZXRob2QuXG4gICAgICAgICAqL1xuXG4gICAgICAgIGZ1bmN0aW9uIFN1YnNjcmlwdGlvbihwdWJsaWNhdGlvbiwgc2NvcGUpIHtcbiAgICAgICAgICAgIHZhciB0aW1lc3RhbXBGaWVsZCwgaXNTeW5jaW5nT24gPSBmYWxzZSwgaXNTaW5nbGUsIHVwZGF0ZURhdGFTdG9yYWdlLCBjYWNoZSwgaXNJbml0aWFsUHVzaENvbXBsZXRlZCwgZGVmZXJyZWRJbml0aWFsaXphdGlvbiwgc3RyaWN0TW9kZTtcbiAgICAgICAgICAgIHZhciBvblJlYWR5T2ZmLCBmb3JtYXRSZWNvcmQ7XG4gICAgICAgICAgICB2YXIgcmVjb25uZWN0T2ZmLCBwdWJsaWNhdGlvbkxpc3RlbmVyT2ZmLCBkZXN0cm95T2ZmO1xuICAgICAgICAgICAgdmFyIG9iamVjdENsYXNzO1xuICAgICAgICAgICAgdmFyIHN1YnNjcmlwdGlvbklkO1xuXG4gICAgICAgICAgICB2YXIgc0RzID0gdGhpcztcbiAgICAgICAgICAgIHZhciBzdWJQYXJhbXMgPSB7fTtcbiAgICAgICAgICAgIHZhciByZWNvcmRTdGF0ZXMgPSB7fTtcbiAgICAgICAgICAgIHZhciBpbm5lclNjb3BlOy8vPSAkcm9vdFNjb3BlLiRuZXcodHJ1ZSk7XG4gICAgICAgICAgICB2YXIgc3luY0xpc3RlbmVyID0gbmV3IFN5bmNMaXN0ZW5lcigpO1xuXG5cbiAgICAgICAgICAgIHRoaXMucmVhZHkgPSBmYWxzZTtcbiAgICAgICAgICAgIHRoaXMuc3luY09uID0gc3luY09uO1xuICAgICAgICAgICAgdGhpcy5zeW5jT2ZmID0gc3luY09mZjtcbiAgICAgICAgICAgIHRoaXMuc2V0T25SZWFkeSA9IHNldE9uUmVhZHk7XG5cbiAgICAgICAgICAgIHRoaXMub25SZWFkeSA9IG9uUmVhZHk7XG4gICAgICAgICAgICB0aGlzLm9uVXBkYXRlID0gb25VcGRhdGU7XG4gICAgICAgICAgICB0aGlzLm9uQWRkID0gb25BZGQ7XG4gICAgICAgICAgICB0aGlzLm9uUmVtb3ZlID0gb25SZW1vdmU7XG5cbiAgICAgICAgICAgIHRoaXMuZ2V0RGF0YSA9IGdldERhdGE7XG4gICAgICAgICAgICB0aGlzLnNldFBhcmFtZXRlcnMgPSBzZXRQYXJhbWV0ZXJzO1xuXG4gICAgICAgICAgICB0aGlzLndhaXRGb3JEYXRhUmVhZHkgPSB3YWl0Rm9yRGF0YVJlYWR5O1xuICAgICAgICAgICAgdGhpcy53YWl0Rm9yU3Vic2NyaXB0aW9uUmVhZHkgPSB3YWl0Rm9yU3Vic2NyaXB0aW9uUmVhZHk7XG5cbiAgICAgICAgICAgIHRoaXMuc2V0Rm9yY2UgPSBzZXRGb3JjZTtcbiAgICAgICAgICAgIHRoaXMuaXNTeW5jaW5nID0gaXNTeW5jaW5nO1xuICAgICAgICAgICAgdGhpcy5pc1JlYWR5ID0gaXNSZWFkeTtcblxuICAgICAgICAgICAgdGhpcy5zZXRTaW5nbGUgPSBzZXRTaW5nbGU7XG5cbiAgICAgICAgICAgIHRoaXMuc2V0T2JqZWN0Q2xhc3MgPSBzZXRPYmplY3RDbGFzcztcbiAgICAgICAgICAgIHRoaXMuZ2V0T2JqZWN0Q2xhc3MgPSBnZXRPYmplY3RDbGFzcztcblxuICAgICAgICAgICAgdGhpcy5zZXRTdHJpY3RNb2RlID0gc2V0U3RyaWN0TW9kZTtcblxuICAgICAgICAgICAgdGhpcy5hdHRhY2ggPSBhdHRhY2g7XG4gICAgICAgICAgICB0aGlzLmRlc3Ryb3kgPSBkZXN0cm95O1xuXG4gICAgICAgICAgICB0aGlzLmlzRXhpc3RpbmdTdGF0ZUZvciA9IGlzRXhpc3RpbmdTdGF0ZUZvcjsgLy8gZm9yIHRlc3RpbmcgcHVycG9zZXNcblxuICAgICAgICAgICAgc2V0U2luZ2xlKGZhbHNlKTtcblxuICAgICAgICAgICAgLy8gdGhpcyB3aWxsIG1ha2Ugc3VyZSB0aGF0IHRoZSBzdWJzY3JpcHRpb24gaXMgcmVsZWFzZWQgZnJvbSBzZXJ2ZXJzIGlmIHRoZSBhcHAgY2xvc2VzIChjbG9zZSBicm93c2VyLCByZWZyZXNoLi4uKVxuICAgICAgICAgICAgYXR0YWNoKHNjb3BlIHx8ICRyb290U2NvcGUpO1xuXG4gICAgICAgICAgICAvLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vXG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIGRlc3Ryb3koKSB7XG4gICAgICAgICAgICAgICAgc3luY09mZigpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvKiogdGhpcyB3aWxsIGJlIGNhbGxlZCB3aGVuIGRhdGEgaXMgYXZhaWxhYmxlIFxuICAgICAgICAgICAgICogIGl0IG1lYW5zIHJpZ2h0IGFmdGVyIGVhY2ggc3luYyFcbiAgICAgICAgICAgICAqIFxuICAgICAgICAgICAgICogXG4gICAgICAgICAgICAqL1xuICAgICAgICAgICAgZnVuY3Rpb24gc2V0T25SZWFkeShjYWxsYmFjaykge1xuICAgICAgICAgICAgICAgIGlmIChvblJlYWR5T2ZmKSB7XG4gICAgICAgICAgICAgICAgICAgIG9uUmVhZHlPZmYoKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgb25SZWFkeU9mZiA9IG9uUmVhZHkoY2FsbGJhY2spO1xuICAgICAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogZm9yY2UgcmVzeW5jaW5nIGZyb20gc2NyYXRjaCBldmVuIGlmIHRoZSBwYXJhbWV0ZXJzIGhhdmUgbm90IGNoYW5nZWRcbiAgICAgICAgICAgICAqIFxuICAgICAgICAgICAgICogaWYgb3V0c2lkZSBjb2RlIGhhcyBtb2RpZmllZCB0aGUgZGF0YSBhbmQgeW91IG5lZWQgdG8gcm9sbGJhY2ssIHlvdSBjb3VsZCBjb25zaWRlciBmb3JjaW5nIGEgcmVmcmVzaCB3aXRoIHRoaXMuIEJldHRlciBzb2x1dGlvbiBzaG91bGQgYmUgZm91bmQgdGhhbiB0aGF0LlxuICAgICAgICAgICAgICogXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIHNldEZvcmNlKHZhbHVlKSB7XG4gICAgICAgICAgICAgICAgaWYgKHZhbHVlKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIHF1aWNrIGhhY2sgdG8gZm9yY2UgdG8gcmVsb2FkLi4ucmVjb2RlIGxhdGVyLlxuICAgICAgICAgICAgICAgICAgICBzRHMuc3luY09mZigpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqIGlmIHNldCB0byB0cnVlLCBpZiBhbiBvYmplY3Qgd2l0aGluIGFuIGFycmF5IHByb3BlcnR5IG9mIHRoZSByZWNvcmQgdG8gc3luYyBoYXMgbm8gSUQgZmllbGQuXG4gICAgICAgICAgICAgKiBhbiBlcnJvciB3b3VsZCBiZSB0aHJvd24uXG4gICAgICAgICAgICAgKiBJdCBpcyBpbXBvcnRhbnQgaWYgd2Ugd2FudCB0byBiZSBhYmxlIHRvIG1haW50YWluIGluc3RhbmNlIHJlZmVyZW5jZXMgZXZlbiBmb3IgdGhlIG9iamVjdHMgaW5zaWRlIGFycmF5cy5cbiAgICAgICAgICAgICAqXG4gICAgICAgICAgICAgKiBGb3JjZXMgdXMgdG8gdXNlIGlkIGV2ZXJ5IHdoZXJlLlxuICAgICAgICAgICAgICpcbiAgICAgICAgICAgICAqIFNob3VsZCBiZSB0aGUgZGVmYXVsdC4uLmJ1dCB0b28gcmVzdHJpY3RpdmUgZm9yIG5vdy5cbiAgICAgICAgICAgICAqL1xuICAgICAgICAgICAgZnVuY3Rpb24gc2V0U3RyaWN0TW9kZSh2YWx1ZSkge1xuICAgICAgICAgICAgICAgIHN0cmljdE1vZGUgPSB2YWx1ZTtcbiAgICAgICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqIFRoZSBmb2xsb3dpbmcgb2JqZWN0IHdpbGwgYmUgYnVpbHQgdXBvbiBlYWNoIHJlY29yZCByZWNlaXZlZCBmcm9tIHRoZSBiYWNrZW5kXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICAqIFRoaXMgY2Fubm90IGJlIG1vZGlmaWVkIGFmdGVyIHRoZSBzeW5jIGhhcyBzdGFydGVkLlxuICAgICAgICAgICAgICogXG4gICAgICAgICAgICAgKiBAcGFyYW0gY2xhc3NWYWx1ZVxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBzZXRPYmplY3RDbGFzcyhjbGFzc1ZhbHVlKSB7XG4gICAgICAgICAgICAgICAgaWYgKGRlZmVycmVkSW5pdGlhbGl6YXRpb24pIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBvYmplY3RDbGFzcyA9IGNsYXNzVmFsdWU7XG4gICAgICAgICAgICAgICAgZm9ybWF0UmVjb3JkID0gZnVuY3Rpb24gKHJlY29yZCkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gbmV3IG9iamVjdENsYXNzKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHNldFNpbmdsZShpc1NpbmdsZSk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gZ2V0T2JqZWN0Q2xhc3MoKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIG9iamVjdENsYXNzO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqIHRoaXMgZnVuY3Rpb24gc3RhcnRzIHRoZSBzeW5jaW5nLlxuICAgICAgICAgICAgICogT25seSBwdWJsaWNhdGlvbiBwdXNoaW5nIGRhdGEgbWF0Y2hpbmcgb3VyIGZldGNoaW5nIHBhcmFtcyB3aWxsIGJlIHJlY2VpdmVkLlxuICAgICAgICAgICAgICogXG4gICAgICAgICAgICAgKiBleDogZm9yIGEgcHVibGljYXRpb24gbmFtZWQgXCJtYWdhemluZXMuc3luY1wiLCBpZiBmZXRjaGluZyBwYXJhbXMgZXF1YWxsZWQge21hZ2F6aW5OYW1lOidjYXJzJ30sIHRoZSBtYWdhemluZSBjYXJzIGRhdGEgd291bGQgYmUgcmVjZWl2ZWQgYnkgdGhpcyBzdWJzY3JpcHRpb24uXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICAqIEBwYXJhbSBmZXRjaGluZ1BhcmFtc1xuICAgICAgICAgICAgICogQHBhcmFtIG9wdGlvbnNcbiAgICAgICAgICAgICAqIFxuICAgICAgICAgICAgICogQHJldHVybnMgYSBwcm9taXNlIHRoYXQgcmVzb2x2ZXMgd2hlbiBkYXRhIGlzIGFycml2ZWQuXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIHNldFBhcmFtZXRlcnMoZmV0Y2hpbmdQYXJhbXMsIG9wdGlvbnMpIHtcbiAgICAgICAgICAgICAgICBpZiAoaXNTeW5jaW5nT24gJiYgYW5ndWxhci5lcXVhbHMoZmV0Y2hpbmdQYXJhbXMsIHN1YlBhcmFtcykpIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gaWYgdGhlIHBhcmFtcyBoYXZlIG5vdCBjaGFuZ2VkLCBqdXN0IHJldHVybnMgd2l0aCBjdXJyZW50IGRhdGEuXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBzRHM7IC8vJHEucmVzb2x2ZShnZXREYXRhKCkpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBzeW5jT2ZmKCk7XG4gICAgICAgICAgICAgICAgaWYgKCFpc1NpbmdsZSkge1xuICAgICAgICAgICAgICAgICAgICBjYWNoZS5sZW5ndGggPSAwO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHN1YlBhcmFtcyA9IGZldGNoaW5nUGFyYW1zIHx8IHt9O1xuICAgICAgICAgICAgICAgIG9wdGlvbnMgPSBvcHRpb25zIHx8IHt9O1xuICAgICAgICAgICAgICAgIGlmIChhbmd1bGFyLmlzRGVmaW5lZChvcHRpb25zLnNpbmdsZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgc2V0U2luZ2xlKG9wdGlvbnMuc2luZ2xlKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgc3luY09uKCk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy8gd2FpdCBmb3IgdGhlIGluaXRpYWwgZmV0Y2ggdG8gY29tcGxldGUgdGhlbiByZXR1cm5zIHRoaXMgc3Vic2NyaXB0aW9uXG4gICAgICAgICAgICBmdW5jdGlvbiB3YWl0Rm9yU3Vic2NyaXB0aW9uUmVhZHkoKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGRlZmVycmVkSW5pdGlhbGl6YXRpb24ucHJvbWlzZS50aGVuKGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy8gd2FpdCBmb3IgdGhlIGluaXRpYWwgZmV0Y2ggdG8gY29tcGxldGUgdGhlbiByZXR1cm5zIHRoZSBkYXRhXG4gICAgICAgICAgICBmdW5jdGlvbiB3YWl0Rm9yRGF0YVJlYWR5KCkge1xuICAgICAgICAgICAgICAgIHJldHVybiBkZWZlcnJlZEluaXRpYWxpemF0aW9uLnByb21pc2U7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIGRvZXMgdGhlIGRhdGFzZXQgcmV0dXJucyBvbmx5IG9uZSBvYmplY3Q/IG5vdCBhbiBhcnJheT9cbiAgICAgICAgICAgIGZ1bmN0aW9uIHNldFNpbmdsZSh2YWx1ZSkge1xuICAgICAgICAgICAgICAgIGlmIChkZWZlcnJlZEluaXRpYWxpemF0aW9uKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgdmFyIHVwZGF0ZUZuO1xuICAgICAgICAgICAgICAgIGlzU2luZ2xlID0gdmFsdWU7XG4gICAgICAgICAgICAgICAgaWYgKHZhbHVlKSB7XG4gICAgICAgICAgICAgICAgICAgIHVwZGF0ZUZuID0gdXBkYXRlU3luY2VkT2JqZWN0O1xuICAgICAgICAgICAgICAgICAgICBjYWNoZSA9IG9iamVjdENsYXNzID8gbmV3IG9iamVjdENsYXNzKHt9KSA6IHt9O1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHVwZGF0ZUZuID0gdXBkYXRlU3luY2VkQXJyYXk7XG4gICAgICAgICAgICAgICAgICAgIGNhY2hlID0gW107XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgdXBkYXRlRGF0YVN0b3JhZ2UgPSBmdW5jdGlvbiAocmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgICAgIHRyeSB7XG4gICAgICAgICAgICAgICAgICAgICAgICB1cGRhdGVGbihyZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICB9IGNhdGNoIChlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBlLm1lc3NhZ2UgPSAnUmVjZWl2ZWQgSW52YWxpZCBvYmplY3QgZnJvbSBwdWJsaWNhdGlvbiBbJyArIHB1YmxpY2F0aW9uICsgJ106ICcgKyBKU09OLnN0cmluZ2lmeShyZWNvcmQpICsgJy4gREVUQUlMUzogJyArIGUubWVzc2FnZTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHRocm93IGU7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyByZXR1cm5zIHRoZSBvYmplY3Qgb3IgYXJyYXkgaW4gc3luY1xuICAgICAgICAgICAgZnVuY3Rpb24gZ2V0RGF0YSgpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gY2FjaGU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogdGhlIGRhdGFzZXQgd2lsbCBzdGFydCBsaXN0ZW5pbmcgdG8gdGhlIGRhdGFzdHJlYW0gXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICAqIE5vdGUgRHVyaW5nIHRoZSBzeW5jLCBpdCB3aWxsIGFsc28gY2FsbCB0aGUgb3B0aW9uYWwgY2FsbGJhY2tzIC0gYWZ0ZXIgcHJvY2Vzc2luZyBFQUNIIHJlY29yZCByZWNlaXZlZC5cbiAgICAgICAgICAgICAqIFxuICAgICAgICAgICAgICogQHJldHVybnMgYSBwcm9taXNlIHRoYXQgd2lsbCBiZSByZXNvbHZlZCB3aGVuIHRoZSBkYXRhIGlzIHJlYWR5LlxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBzeW5jT24oKSB7XG4gICAgICAgICAgICAgICAgaWYgKGlzU3luY2luZ09uKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBkZWZlcnJlZEluaXRpYWxpemF0aW9uLnByb21pc2U7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGRlZmVycmVkSW5pdGlhbGl6YXRpb24gPSAkcS5kZWZlcigpO1xuICAgICAgICAgICAgICAgIGlzSW5pdGlhbFB1c2hDb21wbGV0ZWQgPSBmYWxzZTtcbiAgICAgICAgICAgICAgICBsb2dJbmZvKCdTeW5jICcgKyBwdWJsaWNhdGlvbiArICcgb24uIFBhcmFtczonICsgSlNPTi5zdHJpbmdpZnkoc3ViUGFyYW1zKSk7XG4gICAgICAgICAgICAgICAgaXNTeW5jaW5nT24gPSB0cnVlO1xuICAgICAgICAgICAgICAgIHJlZ2lzdGVyU3Vic2NyaXB0aW9uKCk7XG4gICAgICAgICAgICAgICAgcmVhZHlGb3JMaXN0ZW5pbmcoKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gZGVmZXJyZWRJbml0aWFsaXphdGlvbi5wcm9taXNlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqIHRoZSBkYXRhc2V0IGlzIG5vIGxvbmdlciBsaXN0ZW5pbmcgYW5kIHdpbGwgbm90IGNhbGwgYW55IGNhbGxiYWNrXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIHN5bmNPZmYoKSB7XG4gICAgICAgICAgICAgICAgaWYgKGRlZmVycmVkSW5pdGlhbGl6YXRpb24pIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gaWYgdGhlcmUgaXMgY29kZSB3YWl0aW5nIG9uIHRoaXMgcHJvbWlzZS4uIGV4IChsb2FkIGluIHJlc29sdmUpXG4gICAgICAgICAgICAgICAgICAgIGRlZmVycmVkSW5pdGlhbGl6YXRpb24ucmVzb2x2ZShnZXREYXRhKCkpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBpZiAoaXNTeW5jaW5nT24pIHtcbiAgICAgICAgICAgICAgICAgICAgdW5yZWdpc3RlclN1YnNjcmlwdGlvbigpO1xuICAgICAgICAgICAgICAgICAgICBpc1N5bmNpbmdPbiA9IGZhbHNlO1xuXG4gICAgICAgICAgICAgICAgICAgIGxvZ0luZm8oJ1N5bmMgJyArIHB1YmxpY2F0aW9uICsgJyBvZmYuIFBhcmFtczonICsgSlNPTi5zdHJpbmdpZnkoc3ViUGFyYW1zKSk7XG4gICAgICAgICAgICAgICAgICAgIGlmIChwdWJsaWNhdGlvbkxpc3RlbmVyT2ZmKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBwdWJsaWNhdGlvbkxpc3RlbmVyT2ZmKCk7XG4gICAgICAgICAgICAgICAgICAgICAgICBwdWJsaWNhdGlvbkxpc3RlbmVyT2ZmID0gbnVsbDtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBpZiAocmVjb25uZWN0T2ZmKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZWNvbm5lY3RPZmYoKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJlY29ubmVjdE9mZiA9IG51bGw7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIGlzU3luY2luZygpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gaXNTeW5jaW5nT247XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIHJlYWR5Rm9yTGlzdGVuaW5nKCkge1xuICAgICAgICAgICAgICAgIGlmICghcHVibGljYXRpb25MaXN0ZW5lck9mZikge1xuICAgICAgICAgICAgICAgICAgICBsaXN0ZW5Gb3JSZWNvbm5lY3Rpb25Ub1Jlc3luYygpO1xuICAgICAgICAgICAgICAgICAgICBsaXN0ZW5Ub1B1YmxpY2F0aW9uKCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqICBCeSBkZWZhdWx0IHRoZSByb290c2NvcGUgaXMgYXR0YWNoZWQgaWYgbm8gc2NvcGUgd2FzIHByb3ZpZGVkLiBCdXQgaXQgaXMgcG9zc2libGUgdG8gcmUtYXR0YWNoIGl0IHRvIGEgZGlmZmVyZW50IHNjb3BlLiBpZiB0aGUgc3Vic2NyaXB0aW9uIGRlcGVuZHMgb24gYSBjb250cm9sbGVyLlxuICAgICAgICAgICAgICpcbiAgICAgICAgICAgICAqICBEbyBub3QgYXR0YWNoIGFmdGVyIGl0IGhhcyBzeW5jZWQuXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIGF0dGFjaChuZXdTY29wZSkge1xuICAgICAgICAgICAgICAgIGlmIChkZWZlcnJlZEluaXRpYWxpemF0aW9uKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGlmIChkZXN0cm95T2ZmKSB7XG4gICAgICAgICAgICAgICAgICAgIGRlc3Ryb3lPZmYoKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgaW5uZXJTY29wZSA9IG5ld1Njb3BlO1xuICAgICAgICAgICAgICAgIGRlc3Ryb3lPZmYgPSBpbm5lclNjb3BlLiRvbignJGRlc3Ryb3knLCBkZXN0cm95KTtcblxuICAgICAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIGxpc3RlbkZvclJlY29ubmVjdGlvblRvUmVzeW5jKGxpc3Rlbk5vdykge1xuICAgICAgICAgICAgICAgIC8vIGdpdmUgYSBjaGFuY2UgdG8gY29ubmVjdCBiZWZvcmUgbGlzdGVuaW5nIHRvIHJlY29ubmVjdGlvbi4uLiBAVE9ETyBzaG91bGQgaGF2ZSB1c2VyX3JlY29ubmVjdGVkX2V2ZW50XG4gICAgICAgICAgICAgICAgc2V0VGltZW91dChmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgICAgIHJlY29ubmVjdE9mZiA9IGlubmVyU2NvcGUuJG9uKCd1c2VyX2Nvbm5lY3RlZCcsIGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxvZ0RlYnVnKCdSZXN5bmNpbmcgYWZ0ZXIgbmV0d29yayBsb3NzIHRvICcgKyBwdWJsaWNhdGlvbik7XG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBub3RlIHRoZSBiYWNrZW5kIG1pZ2h0IHJldHVybiBhIG5ldyBzdWJzY3JpcHRpb24gaWYgdGhlIGNsaWVudCB0b29rIHRvbyBtdWNoIHRpbWUgdG8gcmVjb25uZWN0LlxuICAgICAgICAgICAgICAgICAgICAgICAgcmVnaXN0ZXJTdWJzY3JpcHRpb24oKTtcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfSwgbGlzdGVuTm93ID8gMCA6IDIwMDApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiByZWdpc3RlclN1YnNjcmlwdGlvbigpIHtcbiAgICAgICAgICAgICAgICAkc29ja2V0aW8uZmV0Y2goJ3N5bmMuc3Vic2NyaWJlJywge1xuICAgICAgICAgICAgICAgICAgICB2ZXJzaW9uOiBTWU5DX1ZFUlNJT04sXG4gICAgICAgICAgICAgICAgICAgIGlkOiBzdWJzY3JpcHRpb25JZCwgLy8gdG8gdHJ5IHRvIHJlLXVzZSBleGlzdGluZyBzdWJjcmlwdGlvblxuICAgICAgICAgICAgICAgICAgICBwdWJsaWNhdGlvbjogcHVibGljYXRpb24sXG4gICAgICAgICAgICAgICAgICAgIHBhcmFtczogc3ViUGFyYW1zXG4gICAgICAgICAgICAgICAgfSkudGhlbihmdW5jdGlvbiAoc3ViSWQpIHtcbiAgICAgICAgICAgICAgICAgICAgc3Vic2NyaXB0aW9uSWQgPSBzdWJJZDtcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gdW5yZWdpc3RlclN1YnNjcmlwdGlvbigpIHtcbiAgICAgICAgICAgICAgICBpZiAoc3Vic2NyaXB0aW9uSWQpIHtcbiAgICAgICAgICAgICAgICAgICAgJHNvY2tldGlvLmZldGNoKCdzeW5jLnVuc3Vic2NyaWJlJywge1xuICAgICAgICAgICAgICAgICAgICAgICAgdmVyc2lvbjogU1lOQ19WRVJTSU9OLFxuICAgICAgICAgICAgICAgICAgICAgICAgaWQ6IHN1YnNjcmlwdGlvbklkXG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICBzdWJzY3JpcHRpb25JZCA9IG51bGw7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBsaXN0ZW5Ub1B1YmxpY2F0aW9uKCkge1xuICAgICAgICAgICAgICAgIC8vIGNhbm5vdCBvbmx5IGxpc3RlbiB0byBzdWJzY3JpcHRpb25JZCB5ZXQuLi5iZWNhdXNlIHRoZSByZWdpc3RyYXRpb24gbWlnaHQgaGF2ZSBhbnN3ZXIgcHJvdmlkZWQgaXRzIGlkIHlldC4uLmJ1dCBzdGFydGVkIGJyb2FkY2FzdGluZyBjaGFuZ2VzLi4uQFRPRE8gY2FuIGJlIGltcHJvdmVkLi4uXG4gICAgICAgICAgICAgICAgcHVibGljYXRpb25MaXN0ZW5lck9mZiA9IGFkZFB1YmxpY2F0aW9uTGlzdGVuZXIocHVibGljYXRpb24sIGZ1bmN0aW9uIChiYXRjaCkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoc3Vic2NyaXB0aW9uSWQgPT09IGJhdGNoLnN1YnNjcmlwdGlvbklkIHx8ICghc3Vic2NyaXB0aW9uSWQgJiYgY2hlY2tEYXRhU2V0UGFyYW1zSWZNYXRjaGluZ0JhdGNoUGFyYW1zKGJhdGNoLnBhcmFtcykpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWJhdGNoLmRpZmYpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAvLyBDbGVhciB0aGUgY2FjaGUgdG8gcmVidWlsZCBpdCBpZiBhbGwgZGF0YSB3YXMgcmVjZWl2ZWQuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVjb3JkU3RhdGVzID0ge307XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFpc1NpbmdsZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYWNoZS5sZW5ndGggPSAwO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIGFwcGx5Q2hhbmdlcyhiYXRjaC5yZWNvcmRzKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghaXNJbml0aWFsUHVzaENvbXBsZXRlZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlzSW5pdGlhbFB1c2hDb21wbGV0ZWQgPSB0cnVlO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRlZmVycmVkSW5pdGlhbGl6YXRpb24ucmVzb2x2ZShnZXREYXRhKCkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgKiBpZiB0aGUgcGFyYW1zIG9mIHRoZSBkYXRhc2V0IG1hdGNoZXMgdGhlIG5vdGlmaWNhdGlvbiwgaXQgbWVhbnMgdGhlIGRhdGEgbmVlZHMgdG8gYmUgY29sbGVjdCB0byB1cGRhdGUgYXJyYXkuXG4gICAgICAgICAgICAqL1xuICAgICAgICAgICAgZnVuY3Rpb24gY2hlY2tEYXRhU2V0UGFyYW1zSWZNYXRjaGluZ0JhdGNoUGFyYW1zKGJhdGNoUGFyYW1zKSB7XG4gICAgICAgICAgICAgICAgLy8gaWYgKHBhcmFtcy5sZW5ndGggIT0gc3RyZWFtUGFyYW1zLmxlbmd0aCkge1xuICAgICAgICAgICAgICAgIC8vICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICAgICAgLy8gfVxuICAgICAgICAgICAgICAgIGlmICghc3ViUGFyYW1zIHx8IE9iamVjdC5rZXlzKHN1YlBhcmFtcykubGVuZ3RoID09IDApIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRydWVcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgdmFyIG1hdGNoaW5nID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICBmb3IgKHZhciBwYXJhbSBpbiBiYXRjaFBhcmFtcykge1xuICAgICAgICAgICAgICAgICAgICAvLyBhcmUgb3RoZXIgcGFyYW1zIG1hdGNoaW5nP1xuICAgICAgICAgICAgICAgICAgICAvLyBleDogd2UgbWlnaHQgaGF2ZSByZWNlaXZlIGEgbm90aWZpY2F0aW9uIGFib3V0IHRhc2tJZD0yMCBidXQgdGhpcyBzdWJzY3JpcHRpb24gYXJlIG9ubHkgaW50ZXJlc3RlZCBhYm91dCB0YXNrSWQtM1xuICAgICAgICAgICAgICAgICAgICBpZiAoYmF0Y2hQYXJhbXNbcGFyYW1dICE9PSBzdWJQYXJhbXNbcGFyYW1dKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBtYXRjaGluZyA9IGZhbHNlO1xuICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgcmV0dXJuIG1hdGNoaW5nO1xuXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIGZldGNoIGFsbCB0aGUgbWlzc2luZyByZWNvcmRzLCBhbmQgYWN0aXZhdGUgdGhlIGNhbGwgYmFja3MgKGFkZCx1cGRhdGUscmVtb3ZlKSBhY2NvcmRpbmdseSBpZiB0aGVyZSBpcyBzb21ldGhpbmcgdGhhdCBpcyBuZXcgb3Igbm90IGFscmVhZHkgaW4gc3luYy5cbiAgICAgICAgICAgIGZ1bmN0aW9uIGFwcGx5Q2hhbmdlcyhyZWNvcmRzKSB7XG4gICAgICAgICAgICAgICAgdmFyIG5ld0RhdGFBcnJheSA9IFtdO1xuICAgICAgICAgICAgICAgIHZhciBuZXdEYXRhO1xuICAgICAgICAgICAgICAgIHNEcy5yZWFkeSA9IGZhbHNlO1xuICAgICAgICAgICAgICAgIHJlY29yZHMuZm9yRWFjaChmdW5jdGlvbiAocmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vICAgICAgICAgICAgICAgICAgIGxvZ0luZm8oJ0RhdGFzeW5jIFsnICsgZGF0YVN0cmVhbU5hbWUgKyAnXSByZWNlaXZlZDonICtKU09OLnN0cmluZ2lmeShyZWNvcmQpKTsvLysgSlNPTi5zdHJpbmdpZnkocmVjb3JkLmlkKSk7XG4gICAgICAgICAgICAgICAgICAgIGlmIChyZWNvcmQucmVtb3ZlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZW1vdmVSZWNvcmQocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIGlmIChnZXRSZWNvcmRTdGF0ZShyZWNvcmQpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBpZiB0aGUgcmVjb3JkIGlzIGFscmVhZHkgcHJlc2VudCBpbiB0aGUgY2FjaGUuLi5zbyBpdCBpcyBtaWdodGJlIGFuIHVwZGF0ZS4uXG4gICAgICAgICAgICAgICAgICAgICAgICBuZXdEYXRhID0gdXBkYXRlUmVjb3JkKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBuZXdEYXRhID0gYWRkUmVjb3JkKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgaWYgKG5ld0RhdGEpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIG5ld0RhdGFBcnJheS5wdXNoKG5ld0RhdGEpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgc0RzLnJlYWR5ID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICBpZiAoaXNTaW5nbGUpIHtcbiAgICAgICAgICAgICAgICAgICAgc3luY0xpc3RlbmVyLm5vdGlmeSgncmVhZHknLCBnZXREYXRhKCkpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHN5bmNMaXN0ZW5lci5ub3RpZnkoJ3JlYWR5JywgZ2V0RGF0YSgpLCBuZXdEYXRhQXJyYXkpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgKiBBbHRob3VnaCBtb3N0IGNhc2VzIGFyZSBoYW5kbGVkIHVzaW5nIG9uUmVhZHksIHRoaXMgdGVsbHMgeW91IHRoZSBjdXJyZW50IGRhdGEgc3RhdGUuXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICAqIEByZXR1cm5zIGlmIHRydWUgaXMgYSBzeW5jIGhhcyBiZWVuIHByb2Nlc3NlZCBvdGhlcndpc2UgZmFsc2UgaWYgdGhlIGRhdGEgaXMgbm90IHJlYWR5LlxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBpc1JlYWR5KCkge1xuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLnJlYWR5O1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICAqIHJldHVybnMgYSBmdW5jdGlvbiB0byByZW1vdmUgdGhlIGxpc3RlbmVyLlxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBvbkFkZChjYWxsYmFjaykge1xuICAgICAgICAgICAgICAgIHJldHVybiBzeW5jTGlzdGVuZXIub24oJ2FkZCcsIGNhbGxiYWNrKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICAqIHJldHVybnMgYSBmdW5jdGlvbiB0byByZW1vdmUgdGhlIGxpc3RlbmVyLlxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBvblVwZGF0ZShjYWxsYmFjaykge1xuICAgICAgICAgICAgICAgIHJldHVybiBzeW5jTGlzdGVuZXIub24oJ3VwZGF0ZScsIGNhbGxiYWNrKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICAqIHJldHVybnMgYSBmdW5jdGlvbiB0byByZW1vdmUgdGhlIGxpc3RlbmVyLlxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBvblJlbW92ZShjYWxsYmFjaykge1xuICAgICAgICAgICAgICAgIHJldHVybiBzeW5jTGlzdGVuZXIub24oJ3JlbW92ZScsIGNhbGxiYWNrKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICAqIHJldHVybnMgYSBmdW5jdGlvbiB0byByZW1vdmUgdGhlIGxpc3RlbmVyLlxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBvblJlYWR5KGNhbGxiYWNrKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHN5bmNMaXN0ZW5lci5vbigncmVhZHknLCBjYWxsYmFjayk7XG4gICAgICAgICAgICB9XG5cblxuICAgICAgICAgICAgZnVuY3Rpb24gYWRkUmVjb3JkKHJlY29yZCkge1xuICAgICAgICAgICAgICAgIGxvZ0RlYnVnKCdTeW5jIC0+IEluc2VydGVkIE5ldyByZWNvcmQgIycgKyBKU09OLnN0cmluZ2lmeShyZWNvcmQuaWQpICsgJyBmb3Igc3Vic2NyaXB0aW9uIHRvICcgKyBwdWJsaWNhdGlvbik7Ly8gSlNPTi5zdHJpbmdpZnkocmVjb3JkKSk7XG4gICAgICAgICAgICAgICAgZ2V0UmV2aXNpb24ocmVjb3JkKTsgLy8ganVzdCBtYWtlIHN1cmUgd2UgY2FuIGdldCBhIHJldmlzaW9uIGJlZm9yZSB3ZSBoYW5kbGUgdGhpcyByZWNvcmRcbiAgICAgICAgICAgICAgICB1cGRhdGVEYXRhU3RvcmFnZShmb3JtYXRSZWNvcmQgPyBmb3JtYXRSZWNvcmQocmVjb3JkKSA6IHJlY29yZCk7XG4gICAgICAgICAgICAgICAgc3luY0xpc3RlbmVyLm5vdGlmeSgnYWRkJywgcmVjb3JkKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gcmVjb3JkO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiB1cGRhdGVSZWNvcmQocmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgdmFyIHByZXZpb3VzID0gZ2V0UmVjb3JkU3RhdGUocmVjb3JkKTtcbiAgICAgICAgICAgICAgICBpZiAoZ2V0UmV2aXNpb24ocmVjb3JkKSA8PSBnZXRSZXZpc2lvbihwcmV2aW91cykpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGxvZ0RlYnVnKCdTeW5jIC0+IFVwZGF0ZWQgcmVjb3JkICMnICsgSlNPTi5zdHJpbmdpZnkocmVjb3JkLmlkKSArICcgZm9yIHN1YnNjcmlwdGlvbiB0byAnICsgcHVibGljYXRpb24pOy8vIEpTT04uc3RyaW5naWZ5KHJlY29yZCkpO1xuICAgICAgICAgICAgICAgIHVwZGF0ZURhdGFTdG9yYWdlKGZvcm1hdFJlY29yZCA/IGZvcm1hdFJlY29yZChyZWNvcmQpIDogcmVjb3JkKTtcbiAgICAgICAgICAgICAgICBzeW5jTGlzdGVuZXIubm90aWZ5KCd1cGRhdGUnLCByZWNvcmQpO1xuICAgICAgICAgICAgICAgIHJldHVybiByZWNvcmQ7XG4gICAgICAgICAgICB9XG5cblxuICAgICAgICAgICAgZnVuY3Rpb24gcmVtb3ZlUmVjb3JkKHJlY29yZCkge1xuICAgICAgICAgICAgICAgIHZhciBwcmV2aW91cyA9IGdldFJlY29yZFN0YXRlKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgaWYgKCFwcmV2aW91cyB8fCBnZXRSZXZpc2lvbihyZWNvcmQpID4gZ2V0UmV2aXNpb24ocHJldmlvdXMpKSB7XG4gICAgICAgICAgICAgICAgICAgIGxvZ0RlYnVnKCdTeW5jIC0+IFJlbW92ZWQgIycgKyBKU09OLnN0cmluZ2lmeShyZWNvcmQuaWQpICsgJyBmb3Igc3Vic2NyaXB0aW9uIHRvICcgKyBwdWJsaWNhdGlvbik7XG4gICAgICAgICAgICAgICAgICAgIC8vIFdlIGNvdWxkIGhhdmUgZm9yIHRoZSBzYW1lIHJlY29yZCBjb25zZWN1dGl2ZWx5IGZldGNoaW5nIGluIHRoaXMgb3JkZXI6XG4gICAgICAgICAgICAgICAgICAgIC8vIGRlbGV0ZSBpZDo0LCByZXYgMTAsIHRoZW4gYWRkIGlkOjQsIHJldiA5Li4uLiBieSBrZWVwaW5nIHRyYWNrIG9mIHdoYXQgd2FzIGRlbGV0ZWQsIHdlIHdpbGwgbm90IGFkZCB0aGUgcmVjb3JkIHNpbmNlIGl0IHdhcyBkZWxldGVkIHdpdGggYSBtb3N0IHJlY2VudCB0aW1lc3RhbXAuXG4gICAgICAgICAgICAgICAgICAgIHJlY29yZC5yZW1vdmVkID0gdHJ1ZTsgLy8gU28gd2Ugb25seSBmbGFnIGFzIHJlbW92ZWQsIGxhdGVyIG9uIHRoZSBnYXJiYWdlIGNvbGxlY3RvciB3aWxsIGdldCByaWQgb2YgaXQuICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHVwZGF0ZURhdGFTdG9yYWdlKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgIC8vIGlmIHRoZXJlIGlzIG5vIHByZXZpb3VzIHJlY29yZCB3ZSBkbyBub3QgbmVlZCB0byByZW1vdmVkIGFueSB0aGluZyBmcm9tIG91ciBzdG9yYWdlLiAgICAgXG4gICAgICAgICAgICAgICAgICAgIGlmIChwcmV2aW91cykge1xuICAgICAgICAgICAgICAgICAgICAgICAgc3luY0xpc3RlbmVyLm5vdGlmeSgncmVtb3ZlJywgcmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGRpc3Bvc2UocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGZ1bmN0aW9uIGRpc3Bvc2UocmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgJHN5bmNHYXJiYWdlQ29sbGVjdG9yLmRpc3Bvc2UoZnVuY3Rpb24gY29sbGVjdCgpIHtcbiAgICAgICAgICAgICAgICAgICAgdmFyIGV4aXN0aW5nUmVjb3JkID0gZ2V0UmVjb3JkU3RhdGUocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGV4aXN0aW5nUmVjb3JkICYmIHJlY29yZC5yZXZpc2lvbiA+PSBleGlzdGluZ1JlY29yZC5yZXZpc2lvblxuICAgICAgICAgICAgICAgICAgICApIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vbG9nRGVidWcoJ0NvbGxlY3QgTm93OicgKyBKU09OLnN0cmluZ2lmeShyZWNvcmQpKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGRlbGV0ZSByZWNvcmRTdGF0ZXNbZ2V0SWRWYWx1ZShyZWNvcmQuaWQpXTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBpc0V4aXN0aW5nU3RhdGVGb3IocmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuICEhZ2V0UmVjb3JkU3RhdGUocmVjb3JkKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gc2F2ZVJlY29yZFN0YXRlKHJlY29yZCkge1xuICAgICAgICAgICAgICAgIHJlY29yZFN0YXRlc1tnZXRJZFZhbHVlKHJlY29yZC5pZCldID0gcmVjb3JkO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBnZXRSZWNvcmRTdGF0ZShyZWNvcmQpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gcmVjb3JkU3RhdGVzW2dldElkVmFsdWUocmVjb3JkLmlkKV07XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIHVwZGF0ZVN5bmNlZE9iamVjdChyZWNvcmQpIHtcbiAgICAgICAgICAgICAgICBzYXZlUmVjb3JkU3RhdGUocmVjb3JkKTtcblxuICAgICAgICAgICAgICAgIGlmICghcmVjb3JkLnJlbW92ZSkge1xuICAgICAgICAgICAgICAgICAgICAkc3luY01lcmdlLm1lcmdlKGNhY2hlLCByZWNvcmQsIHN0cmljdE1vZGUpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICRzeW5jTWVyZ2UuY2xlYXJPYmplY3QoY2FjaGUpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gdXBkYXRlU3luY2VkQXJyYXkocmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgdmFyIGV4aXN0aW5nID0gZ2V0UmVjb3JkU3RhdGUocmVjb3JkKTtcbiAgICAgICAgICAgICAgICBpZiAoIWV4aXN0aW5nKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIGFkZCBuZXcgaW5zdGFuY2VcbiAgICAgICAgICAgICAgICAgICAgc2F2ZVJlY29yZFN0YXRlKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgIGlmICghcmVjb3JkLnJlbW92ZWQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNhY2hlLnB1c2gocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICRzeW5jTWVyZ2UubWVyZ2UoZXhpc3RpbmcsIHJlY29yZCwgc3RyaWN0TW9kZSk7XG4gICAgICAgICAgICAgICAgICAgIGlmIChyZWNvcmQucmVtb3ZlZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgY2FjaGUuc3BsaWNlKGNhY2hlLmluZGV4T2YoZXhpc3RpbmcpLCAxKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gZ2V0UmV2aXNpb24ocmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgLy8gd2hhdCByZXNlcnZlZCBmaWVsZCBkbyB3ZSB1c2UgYXMgdGltZXN0YW1wXG4gICAgICAgICAgICAgICAgaWYgKGFuZ3VsYXIuaXNEZWZpbmVkKHJlY29yZC5yZXZpc2lvbikpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHJlY29yZC5yZXZpc2lvbjtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgaWYgKGFuZ3VsYXIuaXNEZWZpbmVkKHJlY29yZC50aW1lc3RhbXApKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiByZWNvcmQudGltZXN0YW1wO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1N5bmMgcmVxdWlyZXMgYSByZXZpc2lvbiBvciB0aW1lc3RhbXAgcHJvcGVydHkgaW4gcmVjZWl2ZWQgJyArIChvYmplY3RDbGFzcyA/ICdvYmplY3QgWycgKyBvYmplY3RDbGFzcy5uYW1lICsgJ10nIDogJ3JlY29yZCcpKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiB0aGlzIG9iamVjdCBcbiAgICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIFN5bmNMaXN0ZW5lcigpIHtcbiAgICAgICAgICAgIHZhciBldmVudHMgPSB7fTtcbiAgICAgICAgICAgIHZhciBjb3VudCA9IDA7XG5cbiAgICAgICAgICAgIHRoaXMubm90aWZ5ID0gbm90aWZ5O1xuICAgICAgICAgICAgdGhpcy5vbiA9IG9uO1xuXG4gICAgICAgICAgICBmdW5jdGlvbiBub3RpZnkoZXZlbnQsIGRhdGExLCBkYXRhMikge1xuICAgICAgICAgICAgICAgIHZhciBsaXN0ZW5lcnMgPSBldmVudHNbZXZlbnRdO1xuICAgICAgICAgICAgICAgIGlmIChsaXN0ZW5lcnMpIHtcbiAgICAgICAgICAgICAgICAgICAgXy5mb3JFYWNoKGxpc3RlbmVycywgZnVuY3Rpb24gKGNhbGxiYWNrLCBpZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgY2FsbGJhY2soZGF0YTEsIGRhdGEyKTtcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqIEByZXR1cm5zIGhhbmRsZXIgdG8gdW5yZWdpc3RlciBsaXN0ZW5lclxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBvbihldmVudCwgY2FsbGJhY2spIHtcbiAgICAgICAgICAgICAgICB2YXIgbGlzdGVuZXJzID0gZXZlbnRzW2V2ZW50XTtcbiAgICAgICAgICAgICAgICBpZiAoIWxpc3RlbmVycykge1xuICAgICAgICAgICAgICAgICAgICBsaXN0ZW5lcnMgPSBldmVudHNbZXZlbnRdID0ge307XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHZhciBpZCA9IGNvdW50Kys7XG4gICAgICAgICAgICAgICAgbGlzdGVuZXJzW2lkKytdID0gY2FsbGJhY2s7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICAgICAgZGVsZXRlIGxpc3RlbmVyc1tpZF07XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfTtcbiAgICBmdW5jdGlvbiBnZXRJZFZhbHVlKGlkKSB7XG4gICAgICAgIGlmICghXy5pc09iamVjdChpZCkpIHtcbiAgICAgICAgICAgIHJldHVybiBpZDtcbiAgICAgICAgfVxuICAgICAgICAvLyBidWlsZCBjb21wb3NpdGUga2V5IHZhbHVlXG4gICAgICAgIHZhciByID0gXy5qb2luKF8ubWFwKGlkLCBmdW5jdGlvbiAodmFsdWUpIHtcbiAgICAgICAgICAgIHJldHVybiB2YWx1ZTtcbiAgICAgICAgfSksICd+Jyk7XG4gICAgICAgIHJldHVybiByO1xuICAgIH1cblxuXG4gICAgZnVuY3Rpb24gbG9nSW5mbyhtc2cpIHtcbiAgICAgICAgaWYgKGRlYnVnKSB7XG4gICAgICAgICAgICBjb25zb2xlLmRlYnVnKCdTWU5DKGluZm8pOiAnICsgbXNnKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGZ1bmN0aW9uIGxvZ0RlYnVnKG1zZykge1xuICAgICAgICBpZiAoZGVidWcgPT0gMikge1xuICAgICAgICAgICAgY29uc29sZS5kZWJ1ZygnU1lOQyhkZWJ1Zyk6ICcgKyBtc2cpO1xuICAgICAgICB9XG5cbiAgICB9XG5cblxuXG59O1xufSgpKTtcbiJdfQ==
