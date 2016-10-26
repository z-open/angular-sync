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
                startSyncing();
                return sDs;
            }

            /**
             * @returns a promise that waits for the initial fetch to complete then wait for the initial fetch to complete then returns this subscription.
             */
            function waitForSubscriptionReady() {
                return startSyncing().then(function () {
                    return sDs;
                });
            }

            /**
             * @returns a promise that waits for the initial fetch to complete then returns the data
             */
            function waitForDataReady() {
                return startSyncing();
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
             * Activate syncing
             *
             * @returns this subcription
             *
             */
            function syncOn() {
                startSyncing();
                return sDs;
            }


            /**
             * Deactivate syncing
             *
             * the dataset is no longer listening and will not call any callback
             *
             * @returns this subcription
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
                return sDs;
            }

            /**
             * the dataset will start listening to the datastream 
             * 
             * Note During the sync, it will also call the optional callbacks - after processing EACH record received.
             * 
             * @returns a promise that will be resolved when the data is ready.
             */
            function startSyncing() {
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


//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImFuZ3VsYXItc3luYy5qcyIsInN5bmMubW9kdWxlLmpzIiwic2VydmljZXMvc3luYy1nYXJiYWdlLWNvbGxlY3Rvci5zZXJ2aWNlLmpzIiwic2VydmljZXMvc3luYy1tZXJnZS5zZXJ2aWNlLmpzIiwic2VydmljZXMvc3luYy5zZXJ2aWNlLmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLENBQUMsV0FBVztBQUNaOztBQ0RBO0tBQ0EsT0FBQSxRQUFBLENBQUE7OztBRE1BLENBQUMsV0FBVztBQUNaOztBRVJBO0tBQ0EsT0FBQTtLQUNBLFFBQUEseUJBQUE7Ozs7Ozs7Ozs7QUFVQSxTQUFBLHVCQUFBO0lBQ0EsSUFBQSxRQUFBO0lBQ0EsSUFBQSxVQUFBO0lBQ0EsSUFBQSxZQUFBOztJQUVBLElBQUEsVUFBQTtRQUNBLFlBQUE7UUFDQSxZQUFBO1FBQ0EsU0FBQTtRQUNBLFVBQUE7UUFDQSxLQUFBO1FBQ0EsY0FBQTs7O0lBR0EsT0FBQTs7OztJQUlBLFNBQUEsV0FBQSxPQUFBO1FBQ0EsVUFBQTs7O0lBR0EsU0FBQSxhQUFBO1FBQ0EsT0FBQTs7O0lBR0EsU0FBQSxlQUFBO1FBQ0EsT0FBQSxNQUFBOzs7SUFHQSxTQUFBLFFBQUEsU0FBQTtRQUNBLE1BQUEsS0FBQTtZQUNBLFdBQUEsS0FBQTtZQUNBLFNBQUE7O1FBRUEsSUFBQSxDQUFBLFdBQUE7WUFDQSxRQUFBOzs7O0lBSUEsU0FBQSxXQUFBO1FBQ0EsSUFBQSxDQUFBLFNBQUE7WUFDQSxRQUFBO1lBQ0E7O1FBRUEsWUFBQTtRQUNBLFdBQUEsWUFBQTtZQUNBLFFBQUE7WUFDQSxJQUFBLE1BQUEsU0FBQSxHQUFBO2dCQUNBO21CQUNBO2dCQUNBLFlBQUE7O1dBRUEsVUFBQTs7O0lBR0EsU0FBQSxNQUFBO1FBQ0EsSUFBQSxVQUFBLEtBQUEsUUFBQSxVQUFBO1FBQ0EsT0FBQSxNQUFBLFNBQUEsS0FBQSxNQUFBLEdBQUEsYUFBQSxTQUFBO1lBQ0EsTUFBQSxRQUFBOzs7Ozs7QUZnQkEsQ0FB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QkFBQSxPQUFBO1lBQ0EsT0FBQSxJQUFBLGFBQUEsaUJBQUE7Ozs7Ozs7OztRQVNBLFNBQUEsMkJBQUE7WUFDQSxVQUFBLEdBQUEsWUFBQSxVQUFBLGlCQUFBLElBQUE7Z0JBQ0EsUUFBQSxxQ0FBQSxnQkFBQSxPQUFBLFVBQUEsZ0JBQUEsaUJBQUEsZUFBQSxLQUFBLFVBQUEsZ0JBQUEsVUFBQSxnQkFBQSxnQkFBQSxRQUFBLFNBQUEsT0FBQSxnQkFBQSxPQUFBLFNBQUEsU0FBQTtnQkFDQSxJQUFBLFlBQUEscUJBQUEsZ0JBQUE7Z0JBQ0EsSUFBQSxXQUFBO29CQUNBLEtBQUEsSUFBQSxZQUFBLFdBQUE7d0JBQ0EsVUFBQSxVQUFBOzs7Z0JBR0EsR0FBQTs7U0FFQTs7OztRQUlBLFNBQUEsdUJBQUEsWUFBQSxVQUFBO1lBQ0EsSUFBQSxNQUFBO1lBQ0EsSUFBQSxZQUFBLHFCQUFBO1lBQ0EsSUFBQSxDQUFBLFdBQUE7Z0JBQ0EscUJBQUEsY0FBQSxZQUFBOztZQUVBLFVBQUEsT0FBQTs7WUFFQSxPQUFBLFlBQUE7Z0JBQ0EsT0FBQSxVQUFBOzs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztRQTBCQSxTQUFBLGFBQUEsYUFBQSxPQUFBO1lBQ0EsSUFBQSxnQkFBQSxjQUFBLE9BQUEsVUFBQSxtQkFBQSxPQUFBLHdCQUFBLHdCQUFBO1lBQ0EsSUFBQSxZQUFBO1lBQ0EsSUFBQSxjQUFBLHdCQUFBO1lBQ0EsSUFBQTtZQUNBLElBQUE7O1lBRUEsSUFBQSxNQUFBO1lBQ0EsSUFBQSxZQUFBO1lBQ0EsSUFBQSxlQUFBO1lBQ0EsSUFBQTtZQUNBLElBQUEsZUFBQSxJQUFBOzs7WUFHQSxLQUFBLFFBQUE7WUFDQSxLQUFBLFNBQUE7WUFDQSxLQUFBLFVBQUE7WUFDQSxLQUFBLGFBQUE7O1lBRUEsS0FBQSxVQUFBO1lBQ0EsS0FBQSxXQUFBO1lBQ0EsS0FBQSxRQUFBO1lBQ0EsS0FBQSxXQUFBOztZQUVBLEtBQUEsVUFBQTtZQUNBLEtBQUEsZ0JBQUE7O1lBRUEsS0FBQSxtQkFBQTtZQUNBLEtBQUEsMkJBQUE7O1lBRUEsS0FBQSxXQUFBO1lBQ0EsS0FBQSxZQUFBO1lBQ0EsS0FBQSxVQUFBOztZQUVBLEtBQUEsWUFBQTs7WUFFQSxLQUFBLGlCQUFBO1lBQ0EsS0FBQSxpQkFBQTs7WUFFQSxLQUFBLGdCQUFBOztZQUVBLEtBQUEsU0FBQTtZQUNBLEtBQUEsVUFBQTs7WUFFQSxLQUFBLHFCQUFBOztZQUVBLFVBQUE7OztZQUdBLE9BQUEsU0FBQTs7OztZQUlBLFNBQUEsVUFBQTtnQkFDQTs7Ozs7Ozs7WUFRQSxTQUFBLFdBQUEsVUFBQTtnQkFDQSxJQUFBLFlBQUE7b0JBQ0E7O2dCQUVBLGFBQUEsUUFBQTtnQkFDQSxPQUFBOzs7Ozs7Ozs7WUFTQSxTQUFBLFNBQUEsT0FBQTtnQkFDQSxJQUFBLE9BQUE7O29CQUVBLElBQUE7O2dCQUVBLE9BQUE7Ozs7Ozs7Ozs7OztZQVlBLFNBQUEsY0FBQSxPQUFBO2dCQUNBLGFBQUE7Z0JBQ0EsT0FBQTs7Ozs7Ozs7OztZQVVBLFNBQUEsZUFBQSxZQUFBO2dCQUNBLElBQUEsd0JBQUE7b0JBQ0EsT0FBQTs7O2dCQUdBLGNBQUE7Z0JBQ0EsZUFBQSxVQUFBLFFBQUE7b0JBQ0EsT0FBQSxJQUFBLFlBQUE7O2dCQUVBLFVBQUE7Z0JBQ0EsT0FBQTs7O1lBR0EsU0FBQSxpQkFBQTtnQkFDQSxPQUFBOzs7Ozs7Ozs7Ozs7OztZQWNBLFNBQUEsY0FBQSxnQkFBQSxTQUFBO2dCQUNBLElBQUEsZUFBQSxRQUFBLE9BQUEsa0JBQUEsSUFBQSxZQUFBOztvQkFFQSxPQUFBOztnQkFFQTtnQkFDQSxJQUFBLENBQUEsVUFBQTtvQkFDQSxNQUFBLFNBQUE7OztnQkFHQSxZQUFBLGtCQUFBO2dCQUNBLFVBQUEsV0FBQTtnQkFDQSxJQUFBLFFBQUEsVUFBQSxRQUFBLFNBQUE7b0JBQ0EsVUFBQSxRQUFBOztnQkFFQTtnQkFDQSxPQUFBOzs7Ozs7WUFNQSxTQUFBLDJCQUFBO2dCQUNBLE9BQUEsZUFBQSxLQUFBLFlBQUE7b0JBQ0EsT0FBQTs7Ozs7OztZQU9BLFNBQUEsbUJBQUE7Z0JBQ0EsT0FB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T0EsU0FBQSxlQUFBO1lBQ0EsSUFBQSxTQUFBO1lBQ0EsSUFBQSxRQUFBOztZQUVBLEtBQUEsU0FBQTtZQUNBLEtBQUEsS0FBQTs7WUFFQSxTQUFBLE9BQUEsT0FBQSxPQUFBLE9BQUE7Z0JBQ0EsSUFBQSxZQUFBLE9BQUE7Z0JBQ0EsSUFBQSxXQUFBO29CQUNBLEVBQUEsUUFBQSxXQUFBLFVBQUEsVUFBQSxJQUFBO3dCQUNBLFNBQUEsT0FBQTs7Ozs7Ozs7WUFRQSxTQUFBLEdBQUEsT0FBQSxVQUFBO2dCQUNBLElBQUEsWUFBQSxPQUFBO2dCQUNBLElBQUEsQ0FBQSxXQUFBO29CQUNBLFlBQUEsT0FBQSxTQUFBOztnQkFFQSxJQUFBLEtBQUE7Z0JBQ0EsVUFBQSxRQUFBO2dCQUNBLE9BQUEsWUFBQTtvQkFDQSxPQUFBLFVBQUE7Ozs7O0lBS0EsU0FBQSxXQUFBLElBQUE7UUFDQSxJQUFBLENBQUEsRUFBQSxTQUFBLEtBQUE7WUFDQSxPQUFBOzs7UUFHQSxJQUFBLElBQUEsRUFBQSxLQUFBLEVBQUEsSUFBQSxJQUFBLFVBQUEsT0FBQTtZQUNBLE9BQUE7WUFDQTtRQUNBLE9BQUE7Ozs7SUFJQSxTQUFBLFFBQUEsS0FBQTtRQUNBLElBQUEsT0FBQTtZQUNBLFFBQUEsTUFBQSxpQkFBQTs7OztJQUlBLFNBQUEsU0FBQSxLQUFBO1FBQ0EsSUFBQSxTQUFBLEdBQUE7WUFDQSxRQUFBLE1BQUEsa0JBQUE7Ozs7Ozs7Q0FPQTs7O0FKMExBIiwiZmlsZSI6ImFuZ3VsYXItc3luYy5qcyIsInNvdXJjZXNDb250ZW50IjpbIihmdW5jdGlvbigpIHtcblwidXNlIHN0cmljdFwiO1xuXG5hbmd1bGFyXG4gICAgLm1vZHVsZSgnc3luYycsIFsnc29ja2V0aW8tYXV0aCddKTtcbn0oKSk7XG5cbihmdW5jdGlvbigpIHtcblwidXNlIHN0cmljdFwiO1xuXG5hbmd1bGFyXG4gICAgLm1vZHVsZSgnc3luYycpXG4gICAgLmZhY3RvcnkoJyRzeW5jR2FyYmFnZUNvbGxlY3RvcicsIHN5bmNHYXJiYWdlQ29sbGVjdG9yKTtcblxuLyoqXG4gKiBzYWZlbHkgcmVtb3ZlIGRlbGV0ZWQgcmVjb3JkL29iamVjdCBmcm9tIG1lbW9yeSBhZnRlciB0aGUgc3luYyBwcm9jZXNzIGRpc3Bvc2VkIHRoZW0uXG4gKiBcbiAqIFRPRE86IFNlY29uZHMgc2hvdWxkIHJlZmxlY3QgdGhlIG1heCB0aW1lICB0aGF0IHN5bmMgY2FjaGUgaXMgdmFsaWQgKG5ldHdvcmsgbG9zcyB3b3VsZCBmb3JjZSBhIHJlc3luYyksIHdoaWNoIHNob3VsZCBtYXRjaCBtYXhEaXNjb25uZWN0aW9uVGltZUJlZm9yZURyb3BwaW5nU3Vic2NyaXB0aW9uIG9uIHRoZSBzZXJ2ZXIgc2lkZS5cbiAqIFxuICogTm90ZTpcbiAqIHJlbW92ZWQgcmVjb3JkIHNob3VsZCBiZSBkZWxldGVkIGZyb20gdGhlIHN5bmMgaW50ZXJuYWwgY2FjaGUgYWZ0ZXIgYSB3aGlsZSBzbyB0aGF0IHRoZXkgZG8gbm90IHN0YXkgaW4gdGhlIG1lbW9yeS4gVGhleSBjYW5ub3QgYmUgcmVtb3ZlZCB0b28gZWFybHkgYXMgYW4gb2xkZXIgdmVyc2lvbi9zdGFtcCBvZiB0aGUgcmVjb3JkIGNvdWxkIGJlIHJlY2VpdmVkIGFmdGVyIGl0cyByZW1vdmFsLi4ud2hpY2ggd291bGQgcmUtYWRkIHRvIGNhY2hlLi4uZHVlIGFzeW5jaHJvbm91cyBwcm9jZXNzaW5nLi4uXG4gKi9cbmZ1bmN0aW9uIHN5bmNHYXJiYWdlQ29sbGVjdG9yKCkge1xuICAgIHZhciBpdGVtcyA9IFtdO1xuICAgIHZhciBzZWNvbmRzID0gMjtcbiAgICB2YXIgc2NoZWR1bGVkID0gZmFsc2U7XG5cbiAgICB2YXIgc2VydmljZSA9IHtcbiAgICAgICAgc2V0U2Vjb25kczogc2V0U2Vjb25kcyxcbiAgICAgICAgZ2V0U2Vjb25kczogZ2V0U2Vjb25kcyxcbiAgICAgICAgZGlzcG9zZTogZGlzcG9zZSxcbiAgICAgICAgc2NoZWR1bGU6IHNjaGVkdWxlLFxuICAgICAgICBydW46IHJ1bixcbiAgICAgICAgZ2V0SXRlbUNvdW50OiBnZXRJdGVtQ291bnRcbiAgICB9O1xuXG4gICAgcmV0dXJuIHNlcnZpY2U7XG5cbiAgICAvLy8vLy8vLy8vXG5cbiAgICBmdW5jdGlvbiBzZXRTZWNvbmRzKHZhbHVlKSB7XG4gICAgICAgIHNlY29uZHMgPSB2YWx1ZTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBnZXRTZWNvbmRzKCkge1xuICAgICAgICByZXR1cm4gc2Vjb25kcztcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBnZXRJdGVtQ291bnQoKSB7XG4gICAgICAgIHJldHVybiBpdGVtcy5sZW5ndGg7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gZGlzcG9zZShjb2xsZWN0KSB7XG4gICAgICAgIGl0ZW1zLnB1c2goe1xuICAgICAgICAgICAgdGltZXN0YW1wOiBEYXRlLm5vdygpLFxuICAgICAgICAgICAgY29sbGVjdDogY29sbGVjdFxuICAgICAgICB9KTtcbiAgICAgICAgaWYgKCFzY2hlZHVsZWQpIHtcbiAgICAgICAgICAgIHNlcnZpY2Uuc2NoZWR1bGUoKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGZ1bmN0aW9uIHNjaGVkdWxlKCkge1xuICAgICAgICBpZiAoIXNlY29uZHMpIHtcbiAgICAgICAgICAgIHNlcnZpY2UucnVuKCk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgc2NoZWR1bGVkID0gdHJ1ZTtcbiAgICAgICAgc2V0VGltZW91dChmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICBzZXJ2aWNlLnJ1bigpO1xuICAgICAgICAgICAgaWYgKGl0ZW1zLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgICAgICBzY2hlZHVsZSgpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBzY2hlZHVsZWQgPSBmYWxzZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSwgc2Vjb25kcyAqIDEwMDApO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIHJ1bigpIHtcbiAgICAgICAgdmFyIHRpbWVvdXQgPSBEYXRlLm5vdygpIC0gc2Vjb25kcyAqIDEwMDA7XG4gICAgICAgIHdoaWxlIChpdGVtcy5sZW5ndGggPiAwICYmIGl0ZW1zWzBdLnRpbWVzdGFtcCA8PSB0aW1lb3V0KSB7XG4gICAgICAgICAgICBpdGVtcy5zaGlmdCgpLmNvbGxlY3QoKTtcbiAgICAgICAgfVxuICAgIH1cbn1cbn0oKSk7XG5cbihmdW5jdGlvbigpIHtcblwidXNlIHN0cmljdFwiO1xuXG5hbmd1bGFyXG4gICAgLm1vZHVsZSgnc3luYycpXG4gICAgLmZhY3RvcnkoJyRzeW5jTWVyZ2UnLCBzeW5jTWVyZ2UpO1xuXG5mdW5jdGlvbiBzeW5jTWVyZ2UoKSB7XG5cbiAgICByZXR1cm4ge1xuICAgICAgICB1cGRhdGU6IHVwZGF0ZU9iamVjdCxcbiAgICAgICAgY2xlYXJPYmplY3Q6IGNsZWFyT2JqZWN0XG4gICAgfVxuXG5cbiAgICAvKipcbiAgICAgKiBUaGlzIGZ1bmN0aW9uIHVwZGF0ZXMgYW4gb2JqZWN0IHdpdGggdGhlIGNvbnRlbnQgb2YgYW5vdGhlci5cbiAgICAgKiBUaGUgaW5uZXIgb2JqZWN0cyBhbmQgb2JqZWN0cyBpbiBhcnJheSB3aWxsIGFsc28gYmUgdXBkYXRlZC5cbiAgICAgKiBSZWZlcmVuY2VzIHRvIHRoZSBvcmlnaW5hbCBvYmplY3RzIGFyZSBtYWludGFpbmVkIGluIHRoZSBkZXN0aW5hdGlvbiBvYmplY3Qgc28gT25seSBjb250ZW50IGlzIHVwZGF0ZWQuXG4gICAgICpcbiAgICAgKiBUaGUgcHJvcGVydGllcyBpbiB0aGUgc291cmNlIG9iamVjdCB0aGF0IGFyZSBub3QgaW4gdGhlIGRlc3RpbmF0aW9uIHdpbGwgYmUgcmVtb3ZlZCBmcm9tIHRoZSBkZXN0aW5hdGlvbiBvYmplY3QuXG4gICAgICpcbiAgICAgKiBcbiAgICAgKlxuICAgICAqQHBhcmFtIDxvYmplY3Q+IGRlc3RpbmF0aW9uICBvYmplY3QgdG8gdXBkYXRlXG4gICAgICpAcGFyYW0gPG9iamVjdD4gc291cmNlICBvYmplY3QgdG8gdXBkYXRlIGZyb21cbiAgICAgKkBwYXJhbSA8Ym9vbGVhbj4gaXNTdHJpY3RNb2RlIGRlZmF1bHQgZmFsc2UsIGlmIHRydWUgd291bGQgZ2VuZXJhdGUgYW4gZXJyb3IgaWYgaW5uZXIgb2JqZWN0cyBpbiBhcnJheSBkbyBub3QgaGF2ZSBpZCBmaWVsZFxuICAgICAqL1xuICAgIGZ1bmN0aW9uIHVwZGF0ZU9iamVjdChkZXN0aW5hdGlvbiwgc291cmNlLCBpc1N0cmljdE1vZGUpIHtcbiAgICAgICAgaWYgKCFkZXN0aW5hdGlvbikge1xuICAgICAgICAgICAgcmV0dXJuIHNvdXJjZTsvLyBfLmFzc2lnbih7fSwgc291cmNlKTs7XG4gICAgICAgIH1cbiAgICAgICAgLy8gY3JlYXRlIG5ldyBvYmplY3QgY29udGFpbmluZyBvbmx5IHRoZSBwcm9wZXJ0aWVzIG9mIHNvdXJjZSBtZXJnZSB3aXRoIGRlc3RpbmF0aW9uXG4gICAgICAgIHZhciBvYmplY3QgPSB7fTtcbiAgICAgICAgZm9yICh2YXIgcHJvcGVydHkgaW4gc291cmNlKSB7XG4gICAgICAgICAgICBpZiAoXy5pc0FycmF5KHNvdXJjZVtwcm9wZXJ0eV0pKSB7XG4gICAgICAgICAgICAgICAgb2JqZWN0W3Byb3BlcnR5XSA9IHVwZGF0ZUFycmF5KGRlc3RpbmF0aW9uW3Byb3BlcnR5XSwgc291cmNlW3Byb3BlcnR5XSwgaXNTdHJpY3RNb2RlKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoXy5pc0Z1bmN0aW9uKHNvdXJjZVtwcm9wZXJ0eV0pKSB7XG4gICAgICAgICAgICAgICAgb2JqZWN0W3Byb3BlcnR5XSA9IHNvdXJjZVtwcm9wZXJ0eV07XG4gICAgICAgICAgICB9IGVsc2UgaWYgKF8uaXNPYmplY3Qoc291cmNlW3Byb3BlcnR5XSkgJiYgIV8uaXNEYXRlKHNvdXJjZVtwcm9wZXJ0eV0pICkge1xuICAgICAgICAgICAgICAgIG9iamVjdFtwcm9wZXJ0eV0gPSB1cGRhdGVPYmplY3QoZGVzdGluYXRpb25bcHJvcGVydHldLCBzb3VyY2VbcHJvcGVydHldLCBpc1N0cmljdE1vZGUpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBvYmplY3RbcHJvcGVydHldID0gc291cmNlW3Byb3BlcnR5XTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGNsZWFyT2JqZWN0KGRlc3RpbmF0aW9uKTtcbiAgICAgICAgXy5hc3NpZ24oZGVzdGluYXRpb24sIG9iamVjdCk7XG5cbiAgICAgICAgcmV0dXJuIGRlc3RpbmF0aW9uO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIHVwZGF0ZUFycmF5KGRlc3RpbmF0aW9uLCBzb3VyY2UsIGlzU3RyaWN0TW9kZSkge1xuICAgICAgICBpZiAoIWRlc3RpbmF0aW9uKSB7XG4gICAgICAgICAgICByZXR1cm4gc291cmNlO1xuICAgICAgICB9XG4gICAgICAgIHZhciBhcnJheSA9IFtdO1xuICAgICAgICBzb3VyY2UuZm9yRWFjaChmdW5jdGlvbiAoaXRlbSkge1xuICAgICAgICAgICAgLy8gZG9lcyBub3QgdHJ5IHRvIG1haW50YWluIG9iamVjdCByZWZlcmVuY2VzIGluIGFycmF5c1xuICAgICAgICAgICAgLy8gc3VwZXIgbG9vc2UgbW9kZS5cbiAgICAgICAgICAgIGlmIChpc1N0cmljdE1vZGU9PT0nTk9ORScpIHtcbiAgICAgICAgICAgICAgICBhcnJheS5wdXNoKGl0ZW0pO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAvLyBvYmplY3QgaW4gYXJyYXkgbXVzdCBoYXZlIGFuIGlkIG90aGVyd2lzZSB3ZSBjYW4ndCBtYWludGFpbiB0aGUgaW5zdGFuY2UgcmVmZXJlbmNlXG4gICAgICAgICAgICAgICAgaWYgKCFfLmlzQXJyYXkoaXRlbSkgJiYgXy5pc09iamVjdChpdGVtKSkge1xuICAgICAgICAgICAgICAgICAgICAvLyBsZXQgdHJ5IHRvIGZpbmQgdGhlIGluc3RhbmNlXG4gICAgICAgICAgICAgICAgICAgIGlmIChhbmd1bGFyLmlzRGVmaW5lZChpdGVtLmlkKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgYXJyYXkucHVzaCh1cGRhdGVPYmplY3QoXy5maW5kKGRlc3RpbmF0aW9uLCBmdW5jdGlvbiAob2JqKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIG9iai5pZC50b1N0cmluZygpID09PSBpdGVtLmlkLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9KSwgaXRlbSwgaXNTdHJpY3RNb2RlKSk7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoaXNTdHJpY3RNb2RlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdvYmplY3RzIGluIGFycmF5IG11c3QgaGF2ZSBhbiBpZCBvdGhlcndpc2Ugd2UgY2FuXFwndCBtYWludGFpbiB0aGUgaW5zdGFuY2UgcmVmZXJlbmNlLiAnICsgSlNPTi5zdHJpbmdpZnkoaXRlbSkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgYXJyYXkucHVzaChpdGVtKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGFycmF5LnB1c2goaXRlbSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICBkZXN0aW5hdGlvbi5sZW5ndGggPSAwO1xuICAgICAgICBBcnJheS5wcm90b3R5cGUucHVzaC5hcHBseShkZXN0aW5hdGlvbiwgYXJyYXkpO1xuICAgICAgICAvL2FuZ3VsYXIuY29weShkZXN0aW5hdGlvbiwgYXJyYXkpO1xuICAgICAgICByZXR1cm4gZGVzdGluYXRpb247XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gY2xlYXJPYmplY3Qob2JqZWN0KSB7XG4gICAgICAgIE9iamVjdC5rZXlzKG9iamVjdCkuZm9yRWFjaChmdW5jdGlvbiAoa2V5KSB7IGRlbGV0ZSBvYmplY3Rba2V5XTsgfSk7XG4gICAgfVxufTtcbn0oKSk7XG5cbihmdW5jdGlvbigpIHtcblwidXNlIHN0cmljdFwiO1xuXG4vKipcbiAqIFxuICogU2VydmljZSB0aGF0IGFsbG93cyBhbiBhcnJheSBvZiBkYXRhIHJlbWFpbiBpbiBzeW5jIHdpdGggYmFja2VuZC5cbiAqIFxuICogXG4gKiBleDpcbiAqIHdoZW4gdGhlcmUgaXMgYSBub3RpZmljYXRpb24sIG5vdGljYXRpb25TZXJ2aWNlIG5vdGlmaWVzIHRoYXQgdGhlcmUgaXMgc29tZXRoaW5nIG5ldy4uLnRoZW4gdGhlIGRhdGFzZXQgZ2V0IHRoZSBkYXRhIGFuZCBub3RpZmllcyBhbGwgaXRzIGNhbGxiYWNrLlxuICogXG4gKiBOT1RFOiBcbiAqICBcbiAqIFxuICogUHJlLVJlcXVpc3RlOlxuICogLS0tLS0tLS0tLS0tLVxuICogU3luYyByZXF1aXJlcyBvYmplY3RzIGhhdmUgQk9USCBpZCBhbmQgcmV2aXNpb24gZmllbGRzL3Byb3BlcnRpZXMuXG4gKiBcbiAqIFdoZW4gdGhlIGJhY2tlbmQgd3JpdGVzIGFueSBkYXRhIHRvIHRoZSBkYiB0aGF0IGFyZSBzdXBwb3NlZCB0byBiZSBzeW5jcm9uaXplZDpcbiAqIEl0IG11c3QgbWFrZSBzdXJlIGVhY2ggYWRkLCB1cGRhdGUsIHJlbW92YWwgb2YgcmVjb3JkIGlzIHRpbWVzdGFtcGVkLlxuICogSXQgbXVzdCBub3RpZnkgdGhlIGRhdGFzdHJlYW0gKHdpdGggbm90aWZ5Q2hhbmdlIG9yIG5vdGlmeVJlbW92YWwpIHdpdGggc29tZSBwYXJhbXMgc28gdGhhdCBiYWNrZW5kIGtub3dzIHRoYXQgaXQgaGFzIHRvIHB1c2ggYmFjayB0aGUgZGF0YSBiYWNrIHRvIHRoZSBzdWJzY3JpYmVycyAoZXg6IHRoZSB0YXNrQ3JlYXRpb24gd291bGQgbm90aWZ5IHdpdGggaXRzIHBsYW5JZClcbiogXG4gKiBcbiAqL1xuYW5ndWxhclxuICAgIC5tb2R1bGUoJ3N5bmMnKVxuICAgIC5wcm92aWRlcignJHN5bmMnLCBzeW5jUHJvdmlkZXIpO1xuXG5mdW5jdGlvbiBzeW5jUHJvdmlkZXIoKSB7XG5cbiAgICB2YXIgZGVidWc7XG5cbiAgICB0aGlzLnNldERlYnVnID0gZnVuY3Rpb24gKHZhbHVlKSB7XG4gICAgICAgIGRlYnVnID0gdmFsdWU7XG4gICAgfTtcblxuICAgIHRoaXMuJGdldCA9IGZ1bmN0aW9uIHN5bmMoJHJvb3RTY29wZSwgJHEsICRzb2NrZXRpbywgJHN5bmNHYXJiYWdlQ29sbGVjdG9yLCAkc3luY01lcmdlKSB7XG5cbiAgICAgICAgdmFyIHB1YmxpY2F0aW9uTGlzdGVuZXJzID0ge30sXG4gICAgICAgICAgICBwdWJsaWNhdGlvbkxpc3RlbmVyQ291bnQgPSAwO1xuICAgICAgICB2YXIgR1JBQ0VfUEVSSU9EX0lOX1NFQ09ORFMgPSA4O1xuICAgICAgICB2YXIgU1lOQ19WRVJTSU9OID0gJzEuMic7XG5cblxuICAgICAgICBsaXN0ZW5Ub1N5bmNOb3RpZmljYXRpb24oKTtcblxuICAgICAgICB2YXIgc2VydmljZSA9IHtcbiAgICAgICAgICAgIHN1YnNjcmliZTogc3Vic2NyaWJlLFxuICAgICAgICAgICAgcmVzb2x2ZVN1YnNjcmlwdGlvbjogcmVzb2x2ZVN1YnNjcmlwdGlvbixcbiAgICAgICAgICAgIGdldEdyYWNlUGVyaW9kOiBnZXRHcmFjZVBlcmlvZCxcbiAgICAgICAgICAgIGdldElkVmFsdWU6IGdldElkVmFsdWVcbiAgICAgICAgfTtcblxuICAgICAgICByZXR1cm4gc2VydmljZTtcblxuICAgICAgICAvLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vL1xuICAgICAgICAvKipcbiAgICAgICAgICogc3Vic2NyaWJlIHRvIHB1YmxpY2F0aW9uIGFuZCByZXR1cm5zIHRoZSBzdWJzY3JpcHRpb24gd2hlbiBkYXRhIGlzIGF2YWlsYWJsZS4gXG4gICAgICAgICAqIEBwYXJhbSBwdWJsaWNhdGlvbiBuYW1lLiBvbiB0aGUgc2VydmVyIHNpZGUsIGEgcHVibGljYXRpb24gc2hhbGwgZXhpc3QuIGV4OiBtYWdhemluZXMuc3luY1xuICAgICAgICAgKiBAcGFyYW0gcGFyYW1zICAgdGhlIHBhcmFtcyBvYmplY3QgcGFzc2VkIHRvIHRoZSBzdWJzY3JpcHRpb24sIGV4OiB7bWFnYXppbmVJZDonZW50cmVwcmVuZXVyJ30pXG4gICAgICAgICAqIEBwYXJhbSBvYmplY3RDbGFzcyBhbiBpbnN0YW5jZSBvZiB0aGlzIGNsYXNzIHdpbGwgYmUgY3JlYXRlZCBmb3IgZWFjaCByZWNvcmQgcmVjZWl2ZWQuXG4gICAgICAgICAqIHJldHVybnMgYSBwcm9taXNlIHJldHVybmluZyB0aGUgc3Vic2NyaXB0aW9uIHdoZW4gdGhlIGRhdGEgaXMgc3luY2VkXG4gICAgICAgICAqIG9yIHJlamVjdHMgaWYgdGhlIGluaXRpYWwgc3luYyBmYWlscyB0byBjb21wbGV0ZSBpbiBhIGxpbWl0ZWQgYW1vdW50IG9mIHRpbWUuIFxuICAgICAgICAgKiBcbiAgICAgICAgICogdG8gZ2V0IHRoZSBkYXRhIGZyb20gdGhlIGRhdGFTZXQsIGp1c3QgZGF0YVNldC5nZXREYXRhKClcbiAgICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIHJlc29sdmVTdWJzY3JpcHRpb24ocHVibGljYXRpb25OYW1lLCBwYXJhbXMsIG9iamVjdENsYXNzKSB7XG4gICAgICAgICAgICB2YXIgZGVmZXJyZWQgPSAkcS5kZWZlcigpO1xuICAgICAgICAgICAgdmFyIHNEcyA9IHN1YnNjcmliZShwdWJsaWNhdGlvbk5hbWUpLnNldE9iamVjdENsYXNzKG9iamVjdENsYXNzKTtcblxuICAgICAgICAgICAgLy8gZ2l2ZSBhIGxpdHRsZSB0aW1lIGZvciBzdWJzY3JpcHRpb24gdG8gZmV0Y2ggdGhlIGRhdGEuLi5vdGhlcndpc2UgZ2l2ZSB1cCBzbyB0aGF0IHdlIGRvbid0IGdldCBzdHVjayBpbiBhIHJlc29sdmUgd2FpdGluZyBmb3JldmVyLlxuICAgICAgICAgICAgdmFyIGdyYWNlUGVyaW9kID0gc2V0VGltZW91dChmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgaWYgKCFzRHMucmVhZHkpIHtcbiAgICAgICAgICAgICAgICAgICAgc0RzLmRlc3Ryb3koKTtcbiAgICAgICAgICAgICAgICAgICAgbG9nSW5mbygnQXR0ZW1wdCB0byBzdWJzY3JpYmUgdG8gcHVibGljYXRpb24gJyArIHB1YmxpY2F0aW9uTmFtZSArICcgZmFpbGVkJyk7XG4gICAgICAgICAgICAgICAgICAgIGRlZmVycmVkLnJlamVjdCgnU1lOQ19USU1FT1VUJyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSwgR1JBQ0VfUEVSSU9EX0lOX1NFQ09ORFMgKiAxMDAwKTtcblxuICAgICAgICAgICAgc0RzLnNldFBhcmFtZXRlcnMocGFyYW1zKVxuICAgICAgICAgICAgICAgIC53YWl0Rm9yRGF0YVJlYWR5KClcbiAgICAgICAgICAgICAgICAudGhlbihmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgICAgIGNsZWFyVGltZW91dChncmFjZVBlcmlvZCk7XG4gICAgICAgICAgICAgICAgICAgIGRlZmVycmVkLnJlc29sdmUoc0RzKTtcbiAgICAgICAgICAgICAgICB9KS5jYXRjaChmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgICAgIGNsZWFyVGltZW91dChncmFjZVBlcmlvZCk7XG4gICAgICAgICAgICAgICAgICAgIHNEcy5kZXN0cm95KCk7XG4gICAgICAgICAgICAgICAgICAgIGRlZmVycmVkLnJlamVjdCgnRmFpbGVkIHRvIHN1YnNjcmliZSB0byBwdWJsaWNhdGlvbiAnICsgcHVibGljYXRpb25OYW1lICsgJyBmYWlsZWQnKTtcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIHJldHVybiBkZWZlcnJlZC5wcm9taXNlO1xuICAgICAgICB9XG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqIFxuICAgICAgICAgKiBmb3IgdGVzdCBwdXJwb3NlcywgcmV0dXJucyB0aGUgdGltZSByZXNvbHZlU3Vic2NyaXB0aW9uIGJlZm9yZSBpdCB0aW1lcyBvdXQuXG4gICAgICAgICAqL1xuICAgICAgICBmdW5jdGlvbiBnZXRHcmFjZVBlcmlvZCgpIHtcbiAgICAgICAgICAgIHJldHVybiBHUkFDRV9QRVJJT0RfSU5fU0VDT05EUztcbiAgICAgICAgfVxuICAgICAgICAvKipcbiAgICAgICAgICogc3Vic2NyaWJlIHRvIHB1YmxpY2F0aW9uLiBJdCB3aWxsIG5vdCBzeW5jIHVudGlsIHlvdSBzZXQgdGhlIHBhcmFtcy5cbiAgICAgICAgICogXG4gICAgICAgICAqIEBwYXJhbSBwdWJsaWNhdGlvbiBuYW1lLiBvbiB0aGUgc2VydmVyIHNpZGUsIGEgcHVibGljYXRpb24gc2hhbGwgZXhpc3QuIGV4OiBtYWdhemluZXMuc3luY1xuICAgICAgICAgKiBAcGFyYW0gcGFyYW1zICAgdGhlIHBhcmFtcyBvYmplY3QgcGFzc2VkIHRvIHRoZSBzdWJzY3JpcHRpb24sIGV4OiB7bWFnYXppbmVJZDonZW50cmVwcmVuZXVyJ30pXG4gICAgICAgICAqIHJldHVybnMgc3Vic2NyaXB0aW9uXG4gICAgICAgICAqIFxuICAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gc3Vic2NyaWJlKHB1YmxpY2F0aW9uTmFtZSwgc2NvcGUpIHtcbiAgICAgICAgICAgIHJldHVybiBuZXcgU3Vic2NyaXB0aW9uKHB1YmxpY2F0aW9uTmFtZSwgc2NvcGUpO1xuICAgICAgICB9XG5cblxuXG4gICAgICAgIC8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vXG4gICAgICAgIC8vIEhFTFBFUlNcblxuICAgICAgICAvLyBldmVyeSBzeW5jIG5vdGlmaWNhdGlvbiBjb21lcyB0aHJ1IHRoZSBzYW1lIGV2ZW50IHRoZW4gaXQgaXMgZGlzcGF0Y2hlcyB0byB0aGUgdGFyZ2V0ZWQgc3Vic2NyaXB0aW9ucy5cbiAgICAgICAgZnVuY3Rpb24gbGlzdGVuVG9TeW5jTm90aWZpY2F0aW9uKCkge1xuICAgICAgICAgICAgJHNvY2tldGlvLm9uKCdTWU5DX05PVycsIGZ1bmN0aW9uIChzdWJOb3RpZmljYXRpb24sIGZuKSB7XG4gICAgICAgICAgICAgICAgbG9nSW5mbygnU3luY2luZyB3aXRoIHN1YnNjcmlwdGlvbiBbbmFtZTonICsgc3ViTm90aWZpY2F0aW9uLm5hbWUgKyAnLCBpZDonICsgc3ViTm90aWZpY2F0aW9uLnN1YnNjcmlwdGlvbklkICsgJyAsIHBhcmFtczonICsgSlNPTi5zdHJpbmdpZnkoc3ViTm90aWZpY2F0aW9uLnBhcmFtcykgKyAnXS4gUmVjb3JkczonICsgc3ViTm90aWZpY2F0aW9uLnJlY29yZHMubGVuZ3RoICsgJ1snICsgKHN1Yk5vdGlmaWNhdGlvbi5kaWZmID8gJ0RpZmYnIDogJ0FsbCcpICsgJ10nKTtcbiAgICAgICAgICAgICAgICB2YXIgbGlzdGVuZXJzID0gcHVibGljYXRpb25MaXN0ZW5lcnNbc3ViTm90aWZpY2F0aW9uLm5hbWVdO1xuICAgICAgICAgICAgICAgIGlmIChsaXN0ZW5lcnMpIHtcbiAgICAgICAgICAgICAgICAgICAgZm9yICh2YXIgbGlzdGVuZXIgaW4gbGlzdGVuZXJzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsaXN0ZW5lcnNbbGlzdGVuZXJdKHN1Yk5vdGlmaWNhdGlvbik7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgZm4oJ1NZTkNFRCcpOyAvLyBsZXQga25vdyB0aGUgYmFja2VuZCB0aGUgY2xpZW50IHdhcyBhYmxlIHRvIHN5bmMuXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfTtcblxuXG4gICAgICAgIC8vIHRoaXMgYWxsb3dzIGEgZGF0YXNldCB0byBsaXN0ZW4gdG8gYW55IFNZTkNfTk9XIGV2ZW50Li5hbmQgaWYgdGhlIG5vdGlmaWNhdGlvbiBpcyBhYm91dCBpdHMgZGF0YS5cbiAgICAgICAgZnVuY3Rpb24gYWRkUHVibGljYXRpb25MaXN0ZW5lcihzdHJlYW1OYW1lLCBjYWxsYmFjaykge1xuICAgICAgICAgICAgdmFyIHVpZCA9IHB1YmxpY2F0aW9uTGlzdGVuZXJDb3VudCsrO1xuICAgICAgICAgICAgdmFyIGxpc3RlbmVycyA9IHB1YmxpY2F0aW9uTGlzdGVuZXJzW3N0cmVhbU5hbWVdO1xuICAgICAgICAgICAgaWYgKCFsaXN0ZW5lcnMpIHtcbiAgICAgICAgICAgICAgICBwdWJsaWNhdGlvbkxpc3RlbmVyc1tzdHJlYW1OYW1lXSA9IGxpc3RlbmVycyA9IHt9O1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgbGlzdGVuZXJzW3VpZF0gPSBjYWxsYmFjaztcblxuICAgICAgICAgICAgcmV0dXJuIGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICBkZWxldGUgbGlzdGVuZXJzW3VpZF07XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gICAgICAgIC8vIFN1YnNjcmlwdGlvbiBvYmplY3RcbiAgICAgICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gICAgICAgIC8qKlxuICAgICAgICAgKiBhIHN1YnNjcmlwdGlvbiBzeW5jaHJvbml6ZXMgd2l0aCB0aGUgYmFja2VuZCBmb3IgYW55IGJhY2tlbmQgZGF0YSBjaGFuZ2UgYW5kIG1ha2VzIHRoYXQgZGF0YSBhdmFpbGFibGUgdG8gYSBjb250cm9sbGVyLlxuICAgICAgICAgKiBcbiAgICAgICAgICogIFdoZW4gY2xpZW50IHN1YnNjcmliZXMgdG8gYW4gc3luY3Jvbml6ZWQgYXBpLCBhbnkgZGF0YSBjaGFuZ2UgdGhhdCBpbXBhY3RzIHRoZSBhcGkgcmVzdWx0IFdJTEwgYmUgUFVTSGVkIHRvIHRoZSBjbGllbnQuXG4gICAgICAgICAqIElmIHRoZSBjbGllbnQgZG9lcyBOT1Qgc3Vic2NyaWJlIG9yIHN0b3Agc3Vic2NyaWJlLCBpdCB3aWxsIG5vIGxvbmdlciByZWNlaXZlIHRoZSBQVVNILiBcbiAgICAgICAgICogICAgXG4gICAgICAgICAqIGlmIHRoZSBjb25uZWN0aW9uIGlzIGxvc3QgZm9yIGEgc2hvcnQgdGltZSAoZHVyYXRpb24gZGVmaW5lZCBvbiBzZXJ2ZXItc2lkZSksIHRoZSBzZXJ2ZXIgcXVldWVzIHRoZSBjaGFuZ2VzIGlmIGFueS4gXG4gICAgICAgICAqIFdoZW4gdGhlIGNvbm5lY3Rpb24gcmV0dXJucywgdGhlIG1pc3NpbmcgZGF0YSBhdXRvbWF0aWNhbGx5ICB3aWxsIGJlIFBVU0hlZCB0byB0aGUgc3Vic2NyaWJpbmcgY2xpZW50LlxuICAgICAgICAgKiBpZiB0aGUgY29ubmVjdGlvbiBpcyBsb3N0IGZvciBhIGxvbmcgdGltZSAoZHVyYXRpb24gZGVmaW5lZCBvbiB0aGUgc2VydmVyKSwgdGhlIHNlcnZlciB3aWxsIGRlc3Ryb3kgdGhlIHN1YnNjcmlwdGlvbi4gVG8gc2ltcGxpZnksIHRoZSBjbGllbnQgd2lsbCByZXN1YnNjcmliZSBhdCBpdHMgcmVjb25uZWN0aW9uIGFuZCBnZXQgYWxsIGRhdGEuXG4gICAgICAgICAqIFxuICAgICAgICAgKiBzdWJzY3JpcHRpb24gb2JqZWN0IHByb3ZpZGVzIDMgY2FsbGJhY2tzIChhZGQsdXBkYXRlLCBkZWwpIHdoaWNoIGFyZSBjYWxsZWQgZHVyaW5nIHN5bmNocm9uaXphdGlvbi5cbiAgICAgICAgICogICAgICBcbiAgICAgICAgICogU2NvcGUgd2lsbCBhbGxvdyB0aGUgc3Vic2NyaXB0aW9uIHN0b3Agc3luY2hyb25pemluZyBhbmQgY2FuY2VsIHJlZ2lzdHJhdGlvbiB3aGVuIGl0IGlzIGRlc3Ryb3llZC4gXG4gICAgICAgICAqICBcbiAgICAgICAgICogQ29uc3RydWN0b3I6XG4gICAgICAgICAqIFxuICAgICAgICAgKiBAcGFyYW0gcHVibGljYXRpb24sIHRoZSBwdWJsaWNhdGlvbiBtdXN0IGV4aXN0IG9uIHRoZSBzZXJ2ZXIgc2lkZVxuICAgICAgICAgKiBAcGFyYW0gc2NvcGUsIGJ5IGRlZmF1bHQgJHJvb3RTY29wZSwgYnV0IGNhbiBiZSBtb2RpZmllZCBsYXRlciBvbiB3aXRoIGF0dGFjaCBtZXRob2QuXG4gICAgICAgICAqL1xuXG4gICAgICAgIGZ1bmN0aW9uIFN1YnNjcmlwdGlvbihwdWJsaWNhdGlvbiwgc2NvcGUpIHtcbiAgICAgICAgICAgIHZhciB0aW1lc3RhbXBGaWVsZCwgaXNTeW5jaW5nT24gPSBmYWxzZSwgaXNTaW5nbGUsIHVwZGF0ZURhdGFTdG9yYWdlLCBjYWNoZSwgaXNJbml0aWFsUHVzaENvbXBsZXRlZCwgZGVmZXJyZWRJbml0aWFsaXphdGlvbiwgc3RyaWN0TW9kZTtcbiAgICAgICAgICAgIHZhciBvblJlYWR5T2ZmLCBmb3JtYXRSZWNvcmQ7XG4gICAgICAgICAgICB2YXIgcmVjb25uZWN0T2ZmLCBwdWJsaWNhdGlvbkxpc3RlbmVyT2ZmLCBkZXN0cm95T2ZmO1xuICAgICAgICAgICAgdmFyIG9iamVjdENsYXNzO1xuICAgICAgICAgICAgdmFyIHN1YnNjcmlwdGlvbklkO1xuXG4gICAgICAgICAgICB2YXIgc0RzID0gdGhpcztcbiAgICAgICAgICAgIHZhciBzdWJQYXJhbXMgPSB7fTtcbiAgICAgICAgICAgIHZhciByZWNvcmRTdGF0ZXMgPSB7fTtcbiAgICAgICAgICAgIHZhciBpbm5lclNjb3BlOy8vPSAkcm9vdFNjb3BlLiRuZXcodHJ1ZSk7XG4gICAgICAgICAgICB2YXIgc3luY0xpc3RlbmVyID0gbmV3IFN5bmNMaXN0ZW5lcigpO1xuXG5cbiAgICAgICAgICAgIHRoaXMucmVhZHkgPSBmYWxzZTtcbiAgICAgICAgICAgIHRoaXMuc3luY09uID0gc3luY09uO1xuICAgICAgICAgICAgdGhpcy5zeW5jT2ZmID0gc3luY09mZjtcbiAgICAgICAgICAgIHRoaXMuc2V0T25SZWFkeSA9IHNldE9uUmVhZHk7XG5cbiAgICAgICAgICAgIHRoaXMub25SZWFkeSA9IG9uUmVhZHk7XG4gICAgICAgICAgICB0aGlzLm9uVXBkYXRlID0gb25VcGRhdGU7XG4gICAgICAgICAgICB0aGlzLm9uQWRkID0gb25BZGQ7XG4gICAgICAgICAgICB0aGlzLm9uUmVtb3ZlID0gb25SZW1vdmU7XG5cbiAgICAgICAgICAgIHRoaXMuZ2V0RGF0YSA9IGdldERhdGE7XG4gICAgICAgICAgICB0aGlzLnNldFBhcmFtZXRlcnMgPSBzZXRQYXJhbWV0ZXJzO1xuXG4gICAgICAgICAgICB0aGlzLndhaXRGb3JEYXRhUmVhZHkgPSB3YWl0Rm9yRGF0YVJlYWR5O1xuICAgICAgICAgICAgdGhpcy53YWl0Rm9yU3Vic2NyaXB0aW9uUmVhZHkgPSB3YWl0Rm9yU3Vic2NyaXB0aW9uUmVhZHk7XG5cbiAgICAgICAgICAgIHRoaXMuc2V0Rm9yY2UgPSBzZXRGb3JjZTtcbiAgICAgICAgICAgIHRoaXMuaXNTeW5jaW5nID0gaXNTeW5jaW5nO1xuICAgICAgICAgICAgdGhpcy5pc1JlYWR5ID0gaXNSZWFkeTtcblxuICAgICAgICAgICAgdGhpcy5zZXRTaW5nbGUgPSBzZXRTaW5nbGU7XG5cbiAgICAgICAgICAgIHRoaXMuc2V0T2JqZWN0Q2xhc3MgPSBzZXRPYmplY3RDbGFzcztcbiAgICAgICAgICAgIHRoaXMuZ2V0T2JqZWN0Q2xhc3MgPSBnZXRPYmplY3RDbGFzcztcblxuICAgICAgICAgICAgdGhpcy5zZXRTdHJpY3RNb2RlID0gc2V0U3RyaWN0TW9kZTtcblxuICAgICAgICAgICAgdGhpcy5hdHRhY2ggPSBhdHRhY2g7XG4gICAgICAgICAgICB0aGlzLmRlc3Ryb3kgPSBkZXN0cm95O1xuXG4gICAgICAgICAgICB0aGlzLmlzRXhpc3RpbmdTdGF0ZUZvciA9IGlzRXhpc3RpbmdTdGF0ZUZvcjsgLy8gZm9yIHRlc3RpbmcgcHVycG9zZXNcblxuICAgICAgICAgICAgc2V0U2luZ2xlKGZhbHNlKTtcblxuICAgICAgICAgICAgLy8gdGhpcyB3aWxsIG1ha2Ugc3VyZSB0aGF0IHRoZSBzdWJzY3JpcHRpb24gaXMgcmVsZWFzZWQgZnJvbSBzZXJ2ZXJzIGlmIHRoZSBhcHAgY2xvc2VzIChjbG9zZSBicm93c2VyLCByZWZyZXNoLi4uKVxuICAgICAgICAgICAgYXR0YWNoKHNjb3BlIHx8ICRyb290U2NvcGUpO1xuXG4gICAgICAgICAgICAvLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vXG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIGRlc3Ryb3koKSB7XG4gICAgICAgICAgICAgICAgc3luY09mZigpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvKiogdGhpcyB3aWxsIGJlIGNhbGxlZCB3aGVuIGRhdGEgaXMgYXZhaWxhYmxlIFxuICAgICAgICAgICAgICogIGl0IG1lYW5zIHJpZ2h0IGFmdGVyIGVhY2ggc3luYyFcbiAgICAgICAgICAgICAqIFxuICAgICAgICAgICAgICogXG4gICAgICAgICAgICAqL1xuICAgICAgICAgICAgZnVuY3Rpb24gc2V0T25SZWFkeShjYWxsYmFjaykge1xuICAgICAgICAgICAgICAgIGlmIChvblJlYWR5T2ZmKSB7XG4gICAgICAgICAgICAgICAgICAgIG9uUmVhZHlPZmYoKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgb25SZWFkeU9mZiA9IG9uUmVhZHkoY2FsbGJhY2spO1xuICAgICAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogZm9yY2UgcmVzeW5jaW5nIGZyb20gc2NyYXRjaCBldmVuIGlmIHRoZSBwYXJhbWV0ZXJzIGhhdmUgbm90IGNoYW5nZWRcbiAgICAgICAgICAgICAqIFxuICAgICAgICAgICAgICogaWYgb3V0c2lkZSBjb2RlIGhhcyBtb2RpZmllZCB0aGUgZGF0YSBhbmQgeW91IG5lZWQgdG8gcm9sbGJhY2ssIHlvdSBjb3VsZCBjb25zaWRlciBmb3JjaW5nIGEgcmVmcmVzaCB3aXRoIHRoaXMuIEJldHRlciBzb2x1dGlvbiBzaG91bGQgYmUgZm91bmQgdGhhbiB0aGF0LlxuICAgICAgICAgICAgICogXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIHNldEZvcmNlKHZhbHVlKSB7XG4gICAgICAgICAgICAgICAgaWYgKHZhbHVlKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIHF1aWNrIGhhY2sgdG8gZm9yY2UgdG8gcmVsb2FkLi4ucmVjb2RlIGxhdGVyLlxuICAgICAgICAgICAgICAgICAgICBzRHMuc3luY09mZigpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqIGlmIHNldCB0byB0cnVlLCBpZiBhbiBvYmplY3Qgd2l0aGluIGFuIGFycmF5IHByb3BlcnR5IG9mIHRoZSByZWNvcmQgdG8gc3luYyBoYXMgbm8gSUQgZmllbGQuXG4gICAgICAgICAgICAgKiBhbiBlcnJvciB3b3VsZCBiZSB0aHJvd24uXG4gICAgICAgICAgICAgKiBJdCBpcyBpbXBvcnRhbnQgaWYgd2Ugd2FudCB0byBiZSBhYmxlIHRvIG1haW50YWluIGluc3RhbmNlIHJlZmVyZW5jZXMgZXZlbiBmb3IgdGhlIG9iamVjdHMgaW5zaWRlIGFycmF5cy5cbiAgICAgICAgICAgICAqXG4gICAgICAgICAgICAgKiBGb3JjZXMgdXMgdG8gdXNlIGlkIGV2ZXJ5IHdoZXJlLlxuICAgICAgICAgICAgICpcbiAgICAgICAgICAgICAqIFNob3VsZCBiZSB0aGUgZGVmYXVsdC4uLmJ1dCB0b28gcmVzdHJpY3RpdmUgZm9yIG5vdy5cbiAgICAgICAgICAgICAqL1xuICAgICAgICAgICAgZnVuY3Rpb24gc2V0U3RyaWN0TW9kZSh2YWx1ZSkge1xuICAgICAgICAgICAgICAgIHN0cmljdE1vZGUgPSB2YWx1ZTtcbiAgICAgICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqIFRoZSBmb2xsb3dpbmcgb2JqZWN0IHdpbGwgYmUgYnVpbHQgdXBvbiBlYWNoIHJlY29yZCByZWNlaXZlZCBmcm9tIHRoZSBiYWNrZW5kXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICAqIFRoaXMgY2Fubm90IGJlIG1vZGlmaWVkIGFmdGVyIHRoZSBzeW5jIGhhcyBzdGFydGVkLlxuICAgICAgICAgICAgICogXG4gICAgICAgICAgICAgKiBAcGFyYW0gY2xhc3NWYWx1ZVxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBzZXRPYmplY3RDbGFzcyhjbGFzc1ZhbHVlKSB7XG4gICAgICAgICAgICAgICAgaWYgKGRlZmVycmVkSW5pdGlhbGl6YXRpb24pIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBvYmplY3RDbGFzcyA9IGNsYXNzVmFsdWU7XG4gICAgICAgICAgICAgICAgZm9ybWF0UmVjb3JkID0gZnVuY3Rpb24gKHJlY29yZCkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gbmV3IG9iamVjdENsYXNzKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHNldFNpbmdsZShpc1NpbmdsZSk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gZ2V0T2JqZWN0Q2xhc3MoKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIG9iamVjdENsYXNzO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqIHRoaXMgZnVuY3Rpb24gc3RhcnRzIHRoZSBzeW5jaW5nLlxuICAgICAgICAgICAgICogT25seSBwdWJsaWNhdGlvbiBwdXNoaW5nIGRhdGEgbWF0Y2hpbmcgb3VyIGZldGNoaW5nIHBhcmFtcyB3aWxsIGJlIHJlY2VpdmVkLlxuICAgICAgICAgICAgICogXG4gICAgICAgICAgICAgKiBleDogZm9yIGEgcHVibGljYXRpb24gbmFtZWQgXCJtYWdhemluZXMuc3luY1wiLCBpZiBmZXRjaGluZyBwYXJhbXMgZXF1YWxsZWQge21hZ2F6aW5OYW1lOidjYXJzJ30sIHRoZSBtYWdhemluZSBjYXJzIGRhdGEgd291bGQgYmUgcmVjZWl2ZWQgYnkgdGhpcyBzdWJzY3JpcHRpb24uXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICAqIEBwYXJhbSBmZXRjaGluZ1BhcmFtc1xuICAgICAgICAgICAgICogQHBhcmFtIG9wdGlvbnNcbiAgICAgICAgICAgICAqIFxuICAgICAgICAgICAgICogQHJldHVybnMgYSBwcm9taXNlIHRoYXQgcmVzb2x2ZXMgd2hlbiBkYXRhIGlzIGFycml2ZWQuXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIHNldFBhcmFtZXRlcnMoZmV0Y2hpbmdQYXJhbXMsIG9wdGlvbnMpIHtcbiAgICAgICAgICAgICAgICBpZiAoaXNTeW5jaW5nT24gJiYgYW5ndWxhci5lcXVhbHMoZmV0Y2hpbmdQYXJhbXMgfHwge30sIHN1YlBhcmFtcykpIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gaWYgdGhlIHBhcmFtcyBoYXZlIG5vdCBjaGFuZ2VkLCBqdXN0IHJldHVybnMgd2l0aCBjdXJyZW50IGRhdGEuXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBzRHM7IC8vJHEucmVzb2x2ZShnZXREYXRhKCkpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBzeW5jT2ZmKCk7XG4gICAgICAgICAgICAgICAgaWYgKCFpc1NpbmdsZSkge1xuICAgICAgICAgICAgICAgICAgICBjYWNoZS5sZW5ndGggPSAwO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHN1YlBhcmFtcyA9IGZldGNoaW5nUGFyYW1zIHx8IHt9O1xuICAgICAgICAgICAgICAgIG9wdGlvbnMgPSBvcHRpb25zIHx8IHt9O1xuICAgICAgICAgICAgICAgIGlmIChhbmd1bGFyLmlzRGVmaW5lZChvcHRpb25zLnNpbmdsZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgc2V0U2luZ2xlKG9wdGlvbnMuc2luZ2xlKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgc3RhcnRTeW5jaW5nKCk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgKiBAcmV0dXJucyBhIHByb21pc2UgdGhhdCB3YWl0cyBmb3IgdGhlIGluaXRpYWwgZmV0Y2ggdG8gY29tcGxldGUgdGhlbiB3YWl0IGZvciB0aGUgaW5pdGlhbCBmZXRjaCB0byBjb21wbGV0ZSB0aGVuIHJldHVybnMgdGhpcyBzdWJzY3JpcHRpb24uXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIHdhaXRGb3JTdWJzY3JpcHRpb25SZWFkeSgpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gc3RhcnRTeW5jaW5nKCkudGhlbihmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogQHJldHVybnMgYSBwcm9taXNlIHRoYXQgd2FpdHMgZm9yIHRoZSBpbml0aWFsIGZldGNoIHRvIGNvbXBsZXRlIHRoZW4gcmV0dXJucyB0aGUgZGF0YVxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiB3YWl0Rm9yRGF0YVJlYWR5KCkge1xuICAgICAgICAgICAgICAgIHJldHVybiBzdGFydFN5bmNpbmcoKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy8gZG9lcyB0aGUgZGF0YXNldCByZXR1cm5zIG9ubHkgb25lIG9iamVjdD8gbm90IGFuIGFycmF5P1xuICAgICAgICAgICAgZnVuY3Rpb24gc2V0U2luZ2xlKHZhbHVlKSB7XG4gICAgICAgICAgICAgICAgaWYgKGRlZmVycmVkSW5pdGlhbGl6YXRpb24pIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICB2YXIgdXBkYXRlRm47XG4gICAgICAgICAgICAgICAgaXNTaW5nbGUgPSB2YWx1ZTtcbiAgICAgICAgICAgICAgICBpZiAodmFsdWUpIHtcbiAgICAgICAgICAgICAgICAgICAgdXBkYXRlRm4gPSB1cGRhdGVTeW5jZWRPYmplY3Q7XG4gICAgICAgICAgICAgICAgICAgIGNhY2hlID0gb2JqZWN0Q2xhc3MgPyBuZXcgb2JqZWN0Q2xhc3Moe30pIDoge307XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgdXBkYXRlRm4gPSB1cGRhdGVTeW5jZWRBcnJheTtcbiAgICAgICAgICAgICAgICAgICAgY2FjaGUgPSBbXTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICB1cGRhdGVEYXRhU3RvcmFnZSA9IGZ1bmN0aW9uIChyZWNvcmQpIHtcbiAgICAgICAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHVwZGF0ZUZuKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGUubWVzc2FnZSA9ICdSZWNlaXZlZCBJbnZhbGlkIG9iamVjdCBmcm9tIHB1YmxpY2F0aW9uIFsnICsgcHVibGljYXRpb24gKyAnXTogJyArIEpTT04uc3RyaW5naWZ5KHJlY29yZCkgKyAnLiBERVRBSUxTOiAnICsgZS5tZXNzYWdlO1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgZTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIHJldHVybnMgdGhlIG9iamVjdCBvciBhcnJheSBpbiBzeW5jXG4gICAgICAgICAgICBmdW5jdGlvbiBnZXREYXRhKCkge1xuICAgICAgICAgICAgICAgIHJldHVybiBjYWNoZTtcbiAgICAgICAgICAgIH1cblxuXG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqIEFjdGl2YXRlIHN5bmNpbmdcbiAgICAgICAgICAgICAqXG4gICAgICAgICAgICAgKiBAcmV0dXJucyB0aGlzIHN1YmNyaXB0aW9uXG4gICAgICAgICAgICAgKlxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBzeW5jT24oKSB7XG4gICAgICAgICAgICAgICAgc3RhcnRTeW5jaW5nKCk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgICAgIH1cblxuXG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqIERlYWN0aXZhdGUgc3luY2luZ1xuICAgICAgICAgICAgICpcbiAgICAgICAgICAgICAqIHRoZSBkYXRhc2V0IGlzIG5vIGxvbmdlciBsaXN0ZW5pbmcgYW5kIHdpbGwgbm90IGNhbGwgYW55IGNhbGxiYWNrXG4gICAgICAgICAgICAgKlxuICAgICAgICAgICAgICogQHJldHVybnMgdGhpcyBzdWJjcmlwdGlvblxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBzeW5jT2ZmKCkge1xuICAgICAgICAgICAgICAgIGlmIChkZWZlcnJlZEluaXRpYWxpemF0aW9uKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIGlmIHRoZXJlIGlzIGNvZGUgd2FpdGluZyBvbiB0aGlzIHByb21pc2UuLiBleCAobG9hZCBpbiByZXNvbHZlKVxuICAgICAgICAgICAgICAgICAgICBkZWZlcnJlZEluaXRpYWxpemF0aW9uLnJlc29sdmUoZ2V0RGF0YSgpKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgaWYgKGlzU3luY2luZ09uKSB7XG4gICAgICAgICAgICAgICAgICAgIHVucmVnaXN0ZXJTdWJzY3JpcHRpb24oKTtcbiAgICAgICAgICAgICAgICAgICAgaXNTeW5jaW5nT24gPSBmYWxzZTtcblxuICAgICAgICAgICAgICAgICAgICBsb2dJbmZvKCdTeW5jICcgKyBwdWJsaWNhdGlvbiArICcgb2ZmLiBQYXJhbXM6JyArIEpTT04uc3RyaW5naWZ5KHN1YlBhcmFtcykpO1xuICAgICAgICAgICAgICAgICAgICBpZiAocHVibGljYXRpb25MaXN0ZW5lck9mZikge1xuICAgICAgICAgICAgICAgICAgICAgICAgcHVibGljYXRpb25MaXN0ZW5lck9mZigpO1xuICAgICAgICAgICAgICAgICAgICAgICAgcHVibGljYXRpb25MaXN0ZW5lck9mZiA9IG51bGw7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgaWYgKHJlY29ubmVjdE9mZikge1xuICAgICAgICAgICAgICAgICAgICAgICAgcmVjb25uZWN0T2ZmKCk7XG4gICAgICAgICAgICAgICAgICAgICAgICByZWNvbm5lY3RPZmYgPSBudWxsO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogdGhlIGRhdGFzZXQgd2lsbCBzdGFydCBsaXN0ZW5pbmcgdG8gdGhlIGRhdGFzdHJlYW0gXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICAqIE5vdGUgRHVyaW5nIHRoZSBzeW5jLCBpdCB3aWxsIGFsc28gY2FsbCB0aGUgb3B0aW9uYWwgY2FsbGJhY2tzIC0gYWZ0ZXIgcHJvY2Vzc2luZyBFQUNIIHJlY29yZCByZWNlaXZlZC5cbiAgICAgICAgICAgICAqIFxuICAgICAgICAgICAgICogQHJldHVybnMgYSBwcm9taXNlIHRoYXQgd2lsbCBiZSByZXNvbHZlZCB3aGVuIHRoZSBkYXRhIGlzIHJlYWR5LlxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBzdGFydFN5bmNpbmcoKSB7XG4gICAgICAgICAgICAgICAgaWYgKGlzU3luY2luZ09uKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBkZWZlcnJlZEluaXRpYWxpemF0aW9uLnByb21pc2U7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGRlZmVycmVkSW5pdGlhbGl6YXRpb24gPSAkcS5kZWZlcigpO1xuICAgICAgICAgICAgICAgIGlzSW5pdGlhbFB1c2hDb21wbGV0ZWQgPSBmYWxzZTtcbiAgICAgICAgICAgICAgICBsb2dJbmZvKCdTeW5jICcgKyBwdWJsaWNhdGlvbiArICcgb24uIFBhcmFtczonICsgSlNPTi5zdHJpbmdpZnkoc3ViUGFyYW1zKSk7XG4gICAgICAgICAgICAgICAgaXNTeW5jaW5nT24gPSB0cnVlO1xuICAgICAgICAgICAgICAgIHJlZ2lzdGVyU3Vic2NyaXB0aW9uKCk7XG4gICAgICAgICAgICAgICAgcmVhZHlGb3JMaXN0ZW5pbmcoKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gZGVmZXJyZWRJbml0aWFsaXphdGlvbi5wcm9taXNlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBpc1N5bmNpbmcoKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGlzU3luY2luZ09uO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiByZWFkeUZvckxpc3RlbmluZygpIHtcbiAgICAgICAgICAgICAgICBpZiAoIXB1YmxpY2F0aW9uTGlzdGVuZXJPZmYpIHtcbiAgICAgICAgICAgICAgICAgICAgbGlzdGVuRm9yUmVjb25uZWN0aW9uVG9SZXN5bmMoKTtcbiAgICAgICAgICAgICAgICAgICAgbGlzdGVuVG9QdWJsaWNhdGlvbigpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgKiAgQnkgZGVmYXVsdCB0aGUgcm9vdHNjb3BlIGlzIGF0dGFjaGVkIGlmIG5vIHNjb3BlIHdhcyBwcm92aWRlZC4gQnV0IGl0IGlzIHBvc3NpYmxlIHRvIHJlLWF0dGFjaCBpdCB0byBhIGRpZmZlcmVudCBzY29wZS4gaWYgdGhlIHN1YnNjcmlwdGlvbiBkZXBlbmRzIG9uIGEgY29udHJvbGxlci5cbiAgICAgICAgICAgICAqXG4gICAgICAgICAgICAgKiAgRG8gbm90IGF0dGFjaCBhZnRlciBpdCBoYXMgc3luY2VkLlxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBhdHRhY2gobmV3U2NvcGUpIHtcbiAgICAgICAgICAgICAgICBpZiAoZGVmZXJyZWRJbml0aWFsaXphdGlvbikge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBpZiAoZGVzdHJveU9mZikge1xuICAgICAgICAgICAgICAgICAgICBkZXN0cm95T2ZmKCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGlubmVyU2NvcGUgPSBuZXdTY29wZTtcbiAgICAgICAgICAgICAgICBkZXN0cm95T2ZmID0gaW5uZXJTY29wZS4kb24oJyRkZXN0cm95JywgZGVzdHJveSk7XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBsaXN0ZW5Gb3JSZWNvbm5lY3Rpb25Ub1Jlc3luYyhsaXN0ZW5Ob3cpIHtcbiAgICAgICAgICAgICAgICAvLyBnaXZlIGEgY2hhbmNlIHRvIGNvbm5lY3QgYmVmb3JlIGxpc3RlbmluZyB0byByZWNvbm5lY3Rpb24uLi4gQFRPRE8gc2hvdWxkIGhhdmUgdXNlcl9yZWNvbm5lY3RlZF9ldmVudFxuICAgICAgICAgICAgICAgIHNldFRpbWVvdXQoZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgICAgICByZWNvbm5lY3RPZmYgPSBpbm5lclNjb3BlLiRvbigndXNlcl9jb25uZWN0ZWQnLCBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsb2dEZWJ1ZygnUmVzeW5jaW5nIGFmdGVyIG5ldHdvcmsgbG9zcyB0byAnICsgcHVibGljYXRpb24pO1xuICAgICAgICAgICAgICAgICAgICAgICAgLy8gbm90ZSB0aGUgYmFja2VuZCBtaWdodCByZXR1cm4gYSBuZXcgc3Vic2NyaXB0aW9uIGlmIHRoZSBjbGllbnQgdG9vayB0b28gbXVjaCB0aW1lIHRvIHJlY29ubmVjdC5cbiAgICAgICAgICAgICAgICAgICAgICAgIHJlZ2lzdGVyU3Vic2NyaXB0aW9uKCk7XG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH0sIGxpc3Rlbk5vdyA/IDAgOiAyMDAwKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gcmVnaXN0ZXJTdWJzY3JpcHRpb24oKSB7XG4gICAgICAgICAgICAgICAgJHNvY2tldGlvLmZldGNoKCdzeW5jLnN1YnNjcmliZScsIHtcbiAgICAgICAgICAgICAgICAgICAgdmVyc2lvbjogU1lOQ19WRVJTSU9OLFxuICAgICAgICAgICAgICAgICAgICBpZDogc3Vic2NyaXB0aW9uSWQsIC8vIHRvIHRyeSB0byByZS11c2UgZXhpc3Rpbmcgc3ViY3JpcHRpb25cbiAgICAgICAgICAgICAgICAgICAgcHVibGljYXRpb246IHB1YmxpY2F0aW9uLFxuICAgICAgICAgICAgICAgICAgICBwYXJhbXM6IHN1YlBhcmFtc1xuICAgICAgICAgICAgICAgIH0pLnRoZW4oZnVuY3Rpb24gKHN1YklkKSB7XG4gICAgICAgICAgICAgICAgICAgIHN1YnNjcmlwdGlvbklkID0gc3ViSWQ7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIHVucmVnaXN0ZXJTdWJzY3JpcHRpb24oKSB7XG4gICAgICAgICAgICAgICAgaWYgKHN1YnNjcmlwdGlvbklkKSB7XG4gICAgICAgICAgICAgICAgICAgICRzb2NrZXRpby5mZXRjaCgnc3luYy51bnN1YnNjcmliZScsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHZlcnNpb246IFNZTkNfVkVSU0lPTixcbiAgICAgICAgICAgICAgICAgICAgICAgIGlkOiBzdWJzY3JpcHRpb25JZFxuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgc3Vic2NyaXB0aW9uSWQgPSBudWxsO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gbGlzdGVuVG9QdWJsaWNhdGlvbigpIHtcbiAgICAgICAgICAgICAgICAvLyBjYW5ub3Qgb25seSBsaXN0ZW4gdG8gc3Vic2NyaXB0aW9uSWQgeWV0Li4uYmVjYXVzZSB0aGUgcmVnaXN0cmF0aW9uIG1pZ2h0IGhhdmUgYW5zd2VyIHByb3ZpZGVkIGl0cyBpZCB5ZXQuLi5idXQgc3RhcnRlZCBicm9hZGNhc3RpbmcgY2hhbmdlcy4uLkBUT0RPIGNhbiBiZSBpbXByb3ZlZC4uLlxuICAgICAgICAgICAgICAgIHB1YmxpY2F0aW9uTGlzdGVuZXJPZmYgPSBhZGRQdWJsaWNhdGlvbkxpc3RlbmVyKHB1YmxpY2F0aW9uLCBmdW5jdGlvbiAoYmF0Y2gpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHN1YnNjcmlwdGlvbklkID09PSBiYXRjaC5zdWJzY3JpcHRpb25JZCB8fCAoIXN1YnNjcmlwdGlvbklkICYmIGNoZWNrRGF0YVNldFBhcmFtc0lmTWF0Y2hpbmdCYXRjaFBhcmFtcyhiYXRjaC5wYXJhbXMpKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFiYXRjaC5kaWZmKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLy8gQ2xlYXIgdGhlIGNhY2hlIHRvIHJlYnVpbGQgaXQgaWYgYWxsIGRhdGEgd2FzIHJlY2VpdmVkLlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlY29yZFN0YXRlcyA9IHt9O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghaXNTaW5nbGUpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FjaGUubGVuZ3RoID0gMDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICBhcHBseUNoYW5nZXMoYmF0Y2gucmVjb3Jkcyk7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWlzSW5pdGlhbFB1c2hDb21wbGV0ZWQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpc0luaXRpYWxQdXNoQ29tcGxldGVkID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkZWZlcnJlZEluaXRpYWxpemF0aW9uLnJlc29sdmUoZ2V0RGF0YSgpKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICogaWYgdGhlIHBhcmFtcyBvZiB0aGUgZGF0YXNldCBtYXRjaGVzIHRoZSBub3RpZmljYXRpb24sIGl0IG1lYW5zIHRoZSBkYXRhIG5lZWRzIHRvIGJlIGNvbGxlY3QgdG8gdXBkYXRlIGFycmF5LlxuICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIGNoZWNrRGF0YVNldFBhcmFtc0lmTWF0Y2hpbmdCYXRjaFBhcmFtcyhiYXRjaFBhcmFtcykge1xuICAgICAgICAgICAgICAgIC8vIGlmIChwYXJhbXMubGVuZ3RoICE9IHN0cmVhbVBhcmFtcy5sZW5ndGgpIHtcbiAgICAgICAgICAgICAgICAvLyAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgICAgIC8vIH1cbiAgICAgICAgICAgICAgICBpZiAoIXN1YlBhcmFtcyB8fCBPYmplY3Qua2V5cyhzdWJQYXJhbXMpLmxlbmd0aCA9PSAwKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB0cnVlXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHZhciBtYXRjaGluZyA9IHRydWU7XG4gICAgICAgICAgICAgICAgZm9yICh2YXIgcGFyYW0gaW4gYmF0Y2hQYXJhbXMpIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gYXJlIG90aGVyIHBhcmFtcyBtYXRjaGluZz9cbiAgICAgICAgICAgICAgICAgICAgLy8gZXg6IHdlIG1pZ2h0IGhhdmUgcmVjZWl2ZSBhIG5vdGlmaWNhdGlvbiBhYm91dCB0YXNrSWQ9MjAgYnV0IHRoaXMgc3Vic2NyaXB0aW9uIGFyZSBvbmx5IGludGVyZXN0ZWQgYWJvdXQgdGFza0lkLTNcbiAgICAgICAgICAgICAgICAgICAgaWYgKGJhdGNoUGFyYW1zW3BhcmFtXSAhPT0gc3ViUGFyYW1zW3BhcmFtXSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgbWF0Y2hpbmcgPSBmYWxzZTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHJldHVybiBtYXRjaGluZztcblxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyBmZXRjaCBhbGwgdGhlIG1pc3NpbmcgcmVjb3JkcywgYW5kIGFjdGl2YXRlIHRoZSBjYWxsIGJhY2tzIChhZGQsdXBkYXRlLHJlbW92ZSkgYWNjb3JkaW5nbHkgaWYgdGhlcmUgaXMgc29tZXRoaW5nIHRoYXQgaXMgbmV3IG9yIG5vdCBhbHJlYWR5IGluIHN5bmMuXG4gICAgICAgICAgICBmdW5jdGlvbiBhcHBseUNoYW5nZXMocmVjb3Jkcykge1xuICAgICAgICAgICAgICAgIHZhciBuZXdEYXRhQXJyYXkgPSBbXTtcbiAgICAgICAgICAgICAgICB2YXIgbmV3RGF0YTtcbiAgICAgICAgICAgICAgICBzRHMucmVhZHkgPSBmYWxzZTtcbiAgICAgICAgICAgICAgICByZWNvcmRzLmZvckVhY2goZnVuY3Rpb24gKHJlY29yZCkge1xuICAgICAgICAgICAgICAgICAgICAvLyAgICAgICAgICAgICAgICAgICBsb2dJbmZvKCdEYXRhc3luYyBbJyArIGRhdGFTdHJlYW1OYW1lICsgJ10gcmVjZWl2ZWQ6JyArSlNPTi5zdHJpbmdpZnkocmVjb3JkKSk7Ly8rIEpTT04uc3RyaW5naWZ5KHJlY29yZC5pZCkpO1xuICAgICAgICAgICAgICAgICAgICBpZiAocmVjb3JkLnJlbW92ZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgcmVtb3ZlUmVjb3JkKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoZ2V0UmVjb3JkU3RhdGUocmVjb3JkKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy8gaWYgdGhlIHJlY29yZCBpcyBhbHJlYWR5IHByZXNlbnQgaW4gdGhlIGNhY2hlLi4uc28gaXQgaXMgbWlnaHRiZSBhbiB1cGRhdGUuLlxuICAgICAgICAgICAgICAgICAgICAgICAgbmV3RGF0YSA9IHVwZGF0ZVJlY29yZChyZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgbmV3RGF0YSA9IGFkZFJlY29yZChyZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIGlmIChuZXdEYXRhKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBuZXdEYXRhQXJyYXkucHVzaChuZXdEYXRhKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIHNEcy5yZWFkeSA9IHRydWU7XG4gICAgICAgICAgICAgICAgaWYgKGlzU2luZ2xlKSB7XG4gICAgICAgICAgICAgICAgICAgIHN5bmNMaXN0ZW5lci5ub3RpZnkoJ3JlYWR5JywgZ2V0RGF0YSgpKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzeW5jTGlzdGVuZXIubm90aWZ5KCdyZWFkeScsIGdldERhdGEoKSwgbmV3RGF0YUFycmF5KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogQWx0aG91Z2ggbW9zdCBjYXNlcyBhcmUgaGFuZGxlZCB1c2luZyBvblJlYWR5LCB0aGlzIHRlbGxzIHlvdSB0aGUgY3VycmVudCBkYXRhIHN0YXRlLlxuICAgICAgICAgICAgICogXG4gICAgICAgICAgICAgKiBAcmV0dXJucyBpZiB0cnVlIGlzIGEgc3luYyBoYXMgYmVlbiBwcm9jZXNzZWQgb3RoZXJ3aXNlIGZhbHNlIGlmIHRoZSBkYXRhIGlzIG5vdCByZWFkeS5cbiAgICAgICAgICAgICAqL1xuICAgICAgICAgICAgZnVuY3Rpb24gaXNSZWFkeSgpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5yZWFkeTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogXG4gICAgICAgICAgICAgKiByZXR1cm5zIGEgZnVuY3Rpb24gdG8gcmVtb3ZlIHRoZSBsaXN0ZW5lci5cbiAgICAgICAgICAgICAqL1xuICAgICAgICAgICAgZnVuY3Rpb24gb25BZGQoY2FsbGJhY2spIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gc3luY0xpc3RlbmVyLm9uKCdhZGQnLCBjYWxsYmFjayk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogXG4gICAgICAgICAgICAgKiByZXR1cm5zIGEgZnVuY3Rpb24gdG8gcmVtb3ZlIHRoZSBsaXN0ZW5lci5cbiAgICAgICAgICAgICAqL1xuICAgICAgICAgICAgZnVuY3Rpb24gb25VcGRhdGUoY2FsbGJhY2spIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gc3luY0xpc3RlbmVyLm9uKCd1cGRhdGUnLCBjYWxsYmFjayk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogXG4gICAgICAgICAgICAgKiByZXR1cm5zIGEgZnVuY3Rpb24gdG8gcmVtb3ZlIHRoZSBsaXN0ZW5lci5cbiAgICAgICAgICAgICAqL1xuICAgICAgICAgICAgZnVuY3Rpb24gb25SZW1vdmUoY2FsbGJhY2spIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gc3luY0xpc3RlbmVyLm9uKCdyZW1vdmUnLCBjYWxsYmFjayk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogXG4gICAgICAgICAgICAgKiByZXR1cm5zIGEgZnVuY3Rpb24gdG8gcmVtb3ZlIHRoZSBsaXN0ZW5lci5cbiAgICAgICAgICAgICAqL1xuICAgICAgICAgICAgZnVuY3Rpb24gb25SZWFkeShjYWxsYmFjaykge1xuICAgICAgICAgICAgICAgIHJldHVybiBzeW5jTGlzdGVuZXIub24oJ3JlYWR5JywgY2FsbGJhY2spO1xuICAgICAgICAgICAgfVxuXG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIGFkZFJlY29yZChyZWNvcmQpIHtcbiAgICAgICAgICAgICAgICBsb2dEZWJ1ZygnU3luYyAtPiBJbnNlcnRlZCBOZXcgcmVjb3JkICMnICsgSlNPTi5zdHJpbmdpZnkocmVjb3JkLmlkKSArICcgZm9yIHN1YnNjcmlwdGlvbiB0byAnICsgcHVibGljYXRpb24pOy8vIEpTT04uc3RyaW5naWZ5KHJlY29yZCkpO1xuICAgICAgICAgICAgICAgIGdldFJldmlzaW9uKHJlY29yZCk7IC8vIGp1c3QgbWFrZSBzdXJlIHdlIGNhbiBnZXQgYSByZXZpc2lvbiBiZWZvcmUgd2UgaGFuZGxlIHRoaXMgcmVjb3JkXG4gICAgICAgICAgICAgICAgdXBkYXRlRGF0YVN0b3JhZ2UoZm9ybWF0UmVjb3JkID8gZm9ybWF0UmVjb3JkKHJlY29yZCkgOiByZWNvcmQpO1xuICAgICAgICAgICAgICAgIHN5bmNMaXN0ZW5lci5ub3RpZnkoJ2FkZCcsIHJlY29yZCk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlY29yZDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gdXBkYXRlUmVjb3JkKHJlY29yZCkge1xuICAgICAgICAgICAgICAgIHZhciBwcmV2aW91cyA9IGdldFJlY29yZFN0YXRlKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgaWYgKGdldFJldmlzaW9uKHJlY29yZCkgPD0gZ2V0UmV2aXNpb24ocHJldmlvdXMpKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBudWxsO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBsb2dEZWJ1ZygnU3luYyAtPiBVcGRhdGVkIHJlY29yZCAjJyArIEpTT04uc3RyaW5naWZ5KHJlY29yZC5pZCkgKyAnIGZvciBzdWJzY3JpcHRpb24gdG8gJyArIHB1YmxpY2F0aW9uKTsvLyBKU09OLnN0cmluZ2lmeShyZWNvcmQpKTtcbiAgICAgICAgICAgICAgICB1cGRhdGVEYXRhU3RvcmFnZShmb3JtYXRSZWNvcmQgPyBmb3JtYXRSZWNvcmQocmVjb3JkKSA6IHJlY29yZCk7XG4gICAgICAgICAgICAgICAgc3luY0xpc3RlbmVyLm5vdGlmeSgndXBkYXRlJywgcmVjb3JkKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gcmVjb3JkO1xuICAgICAgICAgICAgfVxuXG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIHJlbW92ZVJlY29yZChyZWNvcmQpIHtcbiAgICAgICAgICAgICAgICB2YXIgcHJldmlvdXMgPSBnZXRSZWNvcmRTdGF0ZShyZWNvcmQpO1xuICAgICAgICAgICAgICAgIGlmICghcHJldmlvdXMgfHwgZ2V0UmV2aXNpb24ocmVjb3JkKSA+IGdldFJldmlzaW9uKHByZXZpb3VzKSkge1xuICAgICAgICAgICAgICAgICAgICBsb2dEZWJ1ZygnU3luYyAtPiBSZW1vdmVkICMnICsgSlNPTi5zdHJpbmdpZnkocmVjb3JkLmlkKSArICcgZm9yIHN1YnNjcmlwdGlvbiB0byAnICsgcHVibGljYXRpb24pO1xuICAgICAgICAgICAgICAgICAgICAvLyBXZSBjb3VsZCBoYXZlIGZvciB0aGUgc2FtZSByZWNvcmQgY29uc2VjdXRpdmVseSBmZXRjaGluZyBpbiB0aGlzIG9yZGVyOlxuICAgICAgICAgICAgICAgICAgICAvLyBkZWxldGUgaWQ6NCwgcmV2IDEwLCB0aGVuIGFkZCBpZDo0LCByZXYgOS4uLi4gYnkga2VlcGluZyB0cmFjayBvZiB3aGF0IHdhcyBkZWxldGVkLCB3ZSB3aWxsIG5vdCBhZGQgdGhlIHJlY29yZCBzaW5jZSBpdCB3YXMgZGVsZXRlZCB3aXRoIGEgbW9zdCByZWNlbnQgdGltZXN0YW1wLlxuICAgICAgICAgICAgICAgICAgICByZWNvcmQucmVtb3ZlZCA9IHRydWU7IC8vIFNvIHdlIG9ubHkgZmxhZyBhcyByZW1vdmVkLCBsYXRlciBvbiB0aGUgZ2FyYmFnZSBjb2xsZWN0b3Igd2lsbCBnZXQgcmlkIG9mIGl0LiAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICB1cGRhdGVEYXRhU3RvcmFnZShyZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICAvLyBpZiB0aGVyZSBpcyBubyBwcmV2aW91cyByZWNvcmQgd2UgZG8gbm90IG5lZWQgdG8gcmVtb3ZlZCBhbnkgdGhpbmcgZnJvbSBvdXIgc3RvcmFnZS4gICAgIFxuICAgICAgICAgICAgICAgICAgICBpZiAocHJldmlvdXMpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHN5bmNMaXN0ZW5lci5ub3RpZnkoJ3JlbW92ZScsIHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgICAgICBkaXNwb3NlKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBmdW5jdGlvbiBkaXNwb3NlKHJlY29yZCkge1xuICAgICAgICAgICAgICAgICRzeW5jR2FyYmFnZUNvbGxlY3Rvci5kaXNwb3NlKGZ1bmN0aW9uIGNvbGxlY3QoKSB7XG4gICAgICAgICAgICAgICAgICAgIHZhciBleGlzdGluZ1JlY29yZCA9IGdldFJlY29yZFN0YXRlKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgIGlmIChleGlzdGluZ1JlY29yZCAmJiByZWNvcmQucmV2aXNpb24gPj0gZXhpc3RpbmdSZWNvcmQucmV2aXNpb25cbiAgICAgICAgICAgICAgICAgICAgKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvL2xvZ0RlYnVnKCdDb2xsZWN0IE5vdzonICsgSlNPTi5zdHJpbmdpZnkocmVjb3JkKSk7XG4gICAgICAgICAgICAgICAgICAgICAgICBkZWxldGUgcmVjb3JkU3RhdGVzW2dldElkVmFsdWUocmVjb3JkLmlkKV07XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gaXNFeGlzdGluZ1N0YXRlRm9yKHJlY29yZCkge1xuICAgICAgICAgICAgICAgIHJldHVybiAhIWdldFJlY29yZFN0YXRlKHJlY29yZCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIHNhdmVSZWNvcmRTdGF0ZShyZWNvcmQpIHtcbiAgICAgICAgICAgICAgICByZWNvcmRTdGF0ZXNbZ2V0SWRWYWx1ZShyZWNvcmQuaWQpXSA9IHJlY29yZDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gZ2V0UmVjb3JkU3RhdGUocmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlY29yZFN0YXRlc1tnZXRJZFZhbHVlKHJlY29yZC5pZCldO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiB1cGRhdGVTeW5jZWRPYmplY3QocmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgc2F2ZVJlY29yZFN0YXRlKHJlY29yZCk7XG5cbiAgICAgICAgICAgICAgICBpZiAoIXJlY29yZC5yZW1vdmUpIHtcbiAgICAgICAgICAgICAgICAgICAgJHN5bmNNZXJnZS51cGRhdGUoY2FjaGUsIHJlY29yZCwgc3RyaWN0TW9kZSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgJHN5bmNNZXJnZS5jbGVhck9iamVjdChjYWNoZSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiB1cGRhdGVTeW5jZWRBcnJheShyZWNvcmQpIHtcbiAgICAgICAgICAgICAgICB2YXIgZXhpc3RpbmcgPSBnZXRSZWNvcmRTdGF0ZShyZWNvcmQpO1xuICAgICAgICAgICAgICAgIGlmICghZXhpc3RpbmcpIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gYWRkIG5ldyBpbnN0YW5jZVxuICAgICAgICAgICAgICAgICAgICBzYXZlUmVjb3JkU3RhdGUocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFyZWNvcmQucmVtb3ZlZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgY2FjaGUucHVzaChyZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgJHN5bmNNZXJnZS51cGRhdGUoZXhpc3RpbmcsIHJlY29yZCwgc3RyaWN0TW9kZSk7XG4gICAgICAgICAgICAgICAgICAgIGlmIChyZWNvcmQucmVtb3ZlZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgY2FjaGUuc3BsaWNlKGNhY2hlLmluZGV4T2YoZXhpc3RpbmcpLCAxKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gZ2V0UmV2aXNpb24ocmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgLy8gd2hhdCByZXNlcnZlZCBmaWVsZCBkbyB3ZSB1c2UgYXMgdGltZXN0YW1wXG4gICAgICAgICAgICAgICAgaWYgKGFuZ3VsYXIuaXNEZWZpbmVkKHJlY29yZC5yZXZpc2lvbikpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHJlY29yZC5yZXZpc2lvbjtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgaWYgKGFuZ3VsYXIuaXNEZWZpbmVkKHJlY29yZC50aW1lc3RhbXApKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiByZWNvcmQudGltZXN0YW1wO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1N5bmMgcmVxdWlyZXMgYSByZXZpc2lvbiBvciB0aW1lc3RhbXAgcHJvcGVydHkgaW4gcmVjZWl2ZWQgJyArIChvYmplY3RDbGFzcyA/ICdvYmplY3QgWycgKyBvYmplY3RDbGFzcy5uYW1lICsgJ10nIDogJ3JlY29yZCcpKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiB0aGlzIG9iamVjdCBcbiAgICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIFN5bmNMaXN0ZW5lcigpIHtcbiAgICAgICAgICAgIHZhciBldmVudHMgPSB7fTtcbiAgICAgICAgICAgIHZhciBjb3VudCA9IDA7XG5cbiAgICAgICAgICAgIHRoaXMubm90aWZ5ID0gbm90aWZ5O1xuICAgICAgICAgICAgdGhpcy5vbiA9IG9uO1xuXG4gICAgICAgICAgICBmdW5jdGlvbiBub3RpZnkoZXZlbnQsIGRhdGExLCBkYXRhMikge1xuICAgICAgICAgICAgICAgIHZhciBsaXN0ZW5lcnMgPSBldmVudHNbZXZlbnRdO1xuICAgICAgICAgICAgICAgIGlmIChsaXN0ZW5lcnMpIHtcbiAgICAgICAgICAgICAgICAgICAgXy5mb3JFYWNoKGxpc3RlbmVycywgZnVuY3Rpb24gKGNhbGxiYWNrLCBpZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgY2FsbGJhY2soZGF0YTEsIGRhdGEyKTtcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqIEByZXR1cm5zIGhhbmRsZXIgdG8gdW5yZWdpc3RlciBsaXN0ZW5lclxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBvbihldmVudCwgY2FsbGJhY2spIHtcbiAgICAgICAgICAgICAgICB2YXIgbGlzdGVuZXJzID0gZXZlbnRzW2V2ZW50XTtcbiAgICAgICAgICAgICAgICBpZiAoIWxpc3RlbmVycykge1xuICAgICAgICAgICAgICAgICAgICBsaXN0ZW5lcnMgPSBldmVudHNbZXZlbnRdID0ge307XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHZhciBpZCA9IGNvdW50Kys7XG4gICAgICAgICAgICAgICAgbGlzdGVuZXJzW2lkKytdID0gY2FsbGJhY2s7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICAgICAgZGVsZXRlIGxpc3RlbmVyc1tpZF07XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfTtcbiAgICBmdW5jdGlvbiBnZXRJZFZhbHVlKGlkKSB7XG4gICAgICAgIGlmICghXy5pc09iamVjdChpZCkpIHtcbiAgICAgICAgICAgIHJldHVybiBpZDtcbiAgICAgICAgfVxuICAgICAgICAvLyBidWlsZCBjb21wb3NpdGUga2V5IHZhbHVlXG4gICAgICAgIHZhciByID0gXy5qb2luKF8ubWFwKGlkLCBmdW5jdGlvbiAodmFsdWUpIHtcbiAgICAgICAgICAgIHJldHVybiB2YWx1ZTtcbiAgICAgICAgfSksICd+Jyk7XG4gICAgICAgIHJldHVybiByO1xuICAgIH1cblxuXG4gICAgZnVuY3Rpb24gbG9nSW5mbyhtc2cpIHtcbiAgICAgICAgaWYgKGRlYnVnKSB7XG4gICAgICAgICAgICBjb25zb2xlLmRlYnVnKCdTWU5DKGluZm8pOiAnICsgbXNnKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGZ1bmN0aW9uIGxvZ0RlYnVnKG1zZykge1xuICAgICAgICBpZiAoZGVidWcgPT0gMikge1xuICAgICAgICAgICAgY29uc29sZS5kZWJ1ZygnU1lOQyhkZWJ1Zyk6ICcgKyBtc2cpO1xuICAgICAgICB9XG5cbiAgICB9XG5cblxuXG59O1xufSgpKTtcblxuIiwiYW5ndWxhclxuICAgIC5tb2R1bGUoJ3N5bmMnLCBbJ3NvY2tldGlvLWF1dGgnXSk7XG4iLCJhbmd1bGFyXG4gICAgLm1vZHVsZSgnc3luYycpXG4gICAgLmZhY3RvcnkoJyRzeW5jR2FyYmFnZUNvbGxlY3RvcicsIHN5bmNHYXJiYWdlQ29sbGVjdG9yKTtcblxuLyoqXG4gKiBzYWZlbHkgcmVtb3ZlIGRlbGV0ZWQgcmVjb3JkL29iamVjdCBmcm9tIG1lbW9yeSBhZnRlciB0aGUgc3luYyBwcm9jZXNzIGRpc3Bvc2VkIHRoZW0uXG4gKiBcbiAqIFRPRE86IFNlY29uZHMgc2hvdWxkIHJlZmxlY3QgdGhlIG1heCB0aW1lICB0aGF0IHN5bmMgY2FjaGUgaXMgdmFsaWQgKG5ldHdvcmsgbG9zcyB3b3VsZCBmb3JjZSBhIHJlc3luYyksIHdoaWNoIHNob3VsZCBtYXRjaCBtYXhEaXNjb25uZWN0aW9uVGltZUJlZm9yZURyb3BwaW5nU3Vic2NyaXB0aW9uIG9uIHRoZSBzZXJ2ZXIgc2lkZS5cbiAqIFxuICogTm90ZTpcbiAqIHJlbW92ZWQgcmVjb3JkIHNob3VsZCBiZSBkZWxldGVkIGZyb20gdGhlIHN5bmMgaW50ZXJuYWwgY2FjaGUgYWZ0ZXIgYSB3aGlsZSBzbyB0aGF0IHRoZXkgZG8gbm90IHN0YXkgaW4gdGhlIG1lbW9yeS4gVGhleSBjYW5ub3QgYmUgcmVtb3ZlZCB0b28gZWFybHkgYXMgYW4gb2xkZXIgdmVyc2lvbi9zdGFtcCBvZiB0aGUgcmVjb3JkIGNvdWxkIGJlIHJlY2VpdmVkIGFmdGVyIGl0cyByZW1vdmFsLi4ud2hpY2ggd291bGQgcmUtYWRkIHRvIGNhY2hlLi4uZHVlIGFzeW5jaHJvbm91cyBwcm9jZXNzaW5nLi4uXG4gKi9cbmZ1bmN0aW9uIHN5bmNHYXJiYWdlQ29sbGVjdG9yKCkge1xuICAgIHZhciBpdGVtcyA9IFtdO1xuICAgIHZhciBzZWNvbmRzID0gMjtcbiAgICB2YXIgc2NoZWR1bGVkID0gZmFsc2U7XG5cbiAgICB2YXIgc2VydmljZSA9IHtcbiAgICAgICAgc2V0U2Vjb25kczogc2V0U2Vjb25kcyxcbiAgICAgICAgZ2V0U2Vjb25kczogZ2V0U2Vjb25kcyxcbiAgICAgICAgZGlzcG9zZTogZGlzcG9zZSxcbiAgICAgICAgc2NoZWR1bGU6IHNjaGVkdWxlLFxuICAgICAgICBydW46IHJ1bixcbiAgICAgICAgZ2V0SXRlbUNvdW50OiBnZXRJdGVtQ291bnRcbiAgICB9O1xuXG4gICAgcmV0dXJuIHNlcnZpY2U7XG5cbiAgICAvLy8vLy8vLy8vXG5cbiAgICBmdW5jdGlvbiBzZXRTZWNvbmRzKHZhbHVlKSB7XG4gICAgICAgIHNlY29uZHMgPSB2YWx1ZTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBnZXRTZWNvbmRzKCkge1xuICAgICAgICByZXR1cm4gc2Vjb25kcztcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBnZXRJdGVtQ291bnQoKSB7XG4gICAgICAgIHJldHVybiBpdGVtcy5sZW5ndGg7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gZGlzcG9zZShjb2xsZWN0KSB7XG4gICAgICAgIGl0ZW1zLnB1c2goe1xuICAgICAgICAgICAgdGltZXN0YW1wOiBEYXRlLm5vdygpLFxuICAgICAgICAgICAgY29sbGVjdDogY29sbGVjdFxuICAgICAgICB9KTtcbiAgICAgICAgaWYgKCFzY2hlZHVsZWQpIHtcbiAgICAgICAgICAgIHNlcnZpY2Uuc2NoZWR1bGUoKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGZ1bmN0aW9uIHNjaGVkdWxlKCkge1xuICAgICAgICBpZiAoIXNlY29uZHMpIHtcbiAgICAgICAgICAgIHNlcnZpY2UucnVuKCk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgc2NoZWR1bGVkID0gdHJ1ZTtcbiAgICAgICAgc2V0VGltZW91dChmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICBzZXJ2aWNlLnJ1bigpO1xuICAgICAgICAgICAgaWYgKGl0ZW1zLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgICAgICBzY2hlZHVsZSgpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBzY2hlZHVsZWQgPSBmYWxzZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSwgc2Vjb25kcyAqIDEwMDApO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIHJ1bigpIHtcbiAgICAgICAgdmFyIHRpbWVvdXQgPSBEYXRlLm5vdygpIC0gc2Vjb25kcyAqIDEwMDA7XG4gICAgICAgIHdoaWxlIChpdGVtcy5sZW5ndGggPiAwICYmIGl0ZW1zWzBdLnRpbWVzdGFtcCA8PSB0aW1lb3V0KSB7XG4gICAgICAgICAgICBpdGVtcy5zaGlmdCgpLmNvbGxlY3QoKTtcbiAgICAgICAgfVxuICAgIH1cbn1cblxuXG4iLCJcbmFuZ3VsYXJcbiAgICAubW9kdWxlKCdzeW5jJylcbiAgICAuZmFjdG9yeSgnJHN5bmNNZXJnZScsIHN5bmNNZXJnZSk7XG5cbmZ1bmN0aW9uIHN5bmNNZXJnZSgpIHtcblxuICAgIHJldHVybiB7XG4gICAgICAgIHVwZGF0ZTogdXBkYXRlT2JqZWN0LFxuICAgICAgICBjbGVhck9iamVjdDogY2xlYXJPYmplY3RcbiAgICB9XG5cblxuICAgIC8qKlxuICAgICAqIFRoaXMgZnVuY3Rpb24gdXBkYXRlcyBhbiBvYmplY3Qgd2l0aCB0aGUgY29udGVudCBvZiBhbm90aGVyLlxuICAgICAqIFRoZSBpbm5lciBvYmplY3RzIGFuZCBvYmplY3RzIGluIGFycmF5IHdpbGwgYWxzbyBiZSB1cGRhdGVkLlxuICAgICAqIFJlZmVyZW5jZXMgdG8gdGhlIG9yaWdpbmFsIG9iamVjdHMgYXJlIG1haW50YWluZWQgaW4gdGhlIGRlc3RpbmF0aW9uIG9iamVjdCBzbyBPbmx5IGNvbnRlbnQgaXMgdXBkYXRlZC5cbiAgICAgKlxuICAgICAqIFRoZSBwcm9wZXJ0aWVzIGluIHRoZSBzb3VyY2Ugb2JqZWN0IHRoYXQgYXJlIG5vdCBpbiB0aGUgZGVzdGluYXRpb24gd2lsbCBiZSByZW1vdmVkIGZyb20gdGhlIGRlc3RpbmF0aW9uIG9iamVjdC5cbiAgICAgKlxuICAgICAqIFxuICAgICAqXG4gICAgICpAcGFyYW0gPG9iamVjdD4gZGVzdGluYXRpb24gIG9iamVjdCB0byB1cGRhdGVcbiAgICAgKkBwYXJhbSA8b2JqZWN0PiBzb3VyY2UgIG9iamVjdCB0byB1cGRhdGUgZnJvbVxuICAgICAqQHBhcmFtIDxib29sZWFuPiBpc1N0cmljdE1vZGUgZGVmYXVsdCBmYWxzZSwgaWYgdHJ1ZSB3b3VsZCBnZW5lcmF0ZSBhbiBlcnJvciBpZiBpbm5lciBvYmplY3RzIGluIGFycmF5IGRvIG5vdCBoYXZlIGlkIGZpZWxkXG4gICAgICovXG4gICAgZnVuY3Rpb24gdXBkYXRlT2JqZWN0KGRlc3RpbmF0aW9uLCBzb3VyY2UsIGlzU3RyaWN0TW9kZSkge1xuICAgICAgICBpZiAoIWRlc3RpbmF0aW9uKSB7XG4gICAgICAgICAgICByZXR1cm4gc291cmNlOy8vIF8uYXNzaWduKHt9LCBzb3VyY2UpOztcbiAgICAgICAgfVxuICAgICAgICAvLyBjcmVhdGUgbmV3IG9iamVjdCBjb250YWluaW5nIG9ubHkgdGhlIHByb3BlcnRpZXMgb2Ygc291cmNlIG1lcmdlIHdpdGggZGVzdGluYXRpb25cbiAgICAgICAgdmFyIG9iamVjdCA9IHt9O1xuICAgICAgICBmb3IgKHZhciBwcm9wZXJ0eSBpbiBzb3VyY2UpIHtcbiAgICAgICAgICAgIGlmIChfLmlzQXJyYXkoc291cmNlW3Byb3BlcnR5XSkpIHtcbiAgICAgICAgICAgICAgICBvYmplY3RbcHJvcGVydHldID0gdXBkYXRlQXJyYXkoZGVzdGluYXRpb25bcHJvcGVydHldLCBzb3VyY2VbcHJvcGVydHldLCBpc1N0cmljdE1vZGUpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChfLmlzRnVuY3Rpb24oc291cmNlW3Byb3BlcnR5XSkpIHtcbiAgICAgICAgICAgICAgICBvYmplY3RbcHJvcGVydHldID0gc291cmNlW3Byb3BlcnR5XTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoXy5pc09iamVjdChzb3VyY2VbcHJvcGVydHldKSAmJiAhXy5pc0RhdGUoc291cmNlW3Byb3BlcnR5XSkgKSB7XG4gICAgICAgICAgICAgICAgb2JqZWN0W3Byb3BlcnR5XSA9IHVwZGF0ZU9iamVjdChkZXN0aW5hdGlvbltwcm9wZXJ0eV0sIHNvdXJjZVtwcm9wZXJ0eV0sIGlzU3RyaWN0TW9kZSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIG9iamVjdFtwcm9wZXJ0eV0gPSBzb3VyY2VbcHJvcGVydHldO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgY2xlYXJPYmplY3QoZGVzdGluYXRpb24pO1xuICAgICAgICBfLmFzc2lnbihkZXN0aW5hdGlvbiwgb2JqZWN0KTtcblxuICAgICAgICByZXR1cm4gZGVzdGluYXRpb247XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gdXBkYXRlQXJyYXkoZGVzdGluYXRpb24sIHNvdXJjZSwgaXNTdHJpY3RNb2RlKSB7XG4gICAgICAgIGlmICghZGVzdGluYXRpb24pIHtcbiAgICAgICAgICAgIHJldHVybiBzb3VyY2U7XG4gICAgICAgIH1cbiAgICAgICAgdmFyIGFycmF5ID0gW107XG4gICAgICAgIHNvdXJjZS5mb3JFYWNoKGZ1bmN0aW9uIChpdGVtKSB7XG4gICAgICAgICAgICAvLyBkb2VzIG5vdCB0cnkgdG8gbWFpbnRhaW4gb2JqZWN0IHJlZmVyZW5jZXMgaW4gYXJyYXlzXG4gICAgICAgICAgICAvLyBzdXBlciBsb29zZSBtb2RlLlxuICAgICAgICAgICAgaWYgKGlzU3RyaWN0TW9kZT09PSdOT05FJykge1xuICAgICAgICAgICAgICAgIGFycmF5LnB1c2goaXRlbSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIC8vIG9iamVjdCBpbiBhcnJheSBtdXN0IGhhdmUgYW4gaWQgb3RoZXJ3aXNlIHdlIGNhbid0IG1haW50YWluIHRoZSBpbnN0YW5jZSByZWZlcmVuY2VcbiAgICAgICAgICAgICAgICBpZiAoIV8uaXNBcnJheShpdGVtKSAmJiBfLmlzT2JqZWN0KGl0ZW0pKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIGxldCB0cnkgdG8gZmluZCB0aGUgaW5zdGFuY2VcbiAgICAgICAgICAgICAgICAgICAgaWYgKGFuZ3VsYXIuaXNEZWZpbmVkKGl0ZW0uaWQpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBhcnJheS5wdXNoKHVwZGF0ZU9iamVjdChfLmZpbmQoZGVzdGluYXRpb24sIGZ1bmN0aW9uIChvYmopIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gb2JqLmlkLnRvU3RyaW5nKCkgPT09IGl0ZW0uaWQudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH0pLCBpdGVtLCBpc1N0cmljdE1vZGUpKTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpc1N0cmljdE1vZGUpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ29iamVjdHMgaW4gYXJyYXkgbXVzdCBoYXZlIGFuIGlkIG90aGVyd2lzZSB3ZSBjYW5cXCd0IG1haW50YWluIHRoZSBpbnN0YW5jZSByZWZlcmVuY2UuICcgKyBKU09OLnN0cmluZ2lmeShpdGVtKSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICBhcnJheS5wdXNoKGl0ZW0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgYXJyYXkucHVzaChpdGVtKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIGRlc3RpbmF0aW9uLmxlbmd0aCA9IDA7XG4gICAgICAgIEFycmF5LnByb3RvdHlwZS5wdXNoLmFwcGx5KGRlc3RpbmF0aW9uLCBhcnJheSk7XG4gICAgICAgIC8vYW5ndWxhci5jb3B5KGRlc3RpbmF0aW9uLCBhcnJheSk7XG4gICAgICAgIHJldHVybiBkZXN0aW5hdGlvbjtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBjbGVhck9iamVjdChvYmplY3QpIHtcbiAgICAgICAgT2JqZWN0LmtleXMob2JqZWN0KS5mb3JFYWNoKGZ1bmN0aW9uIChrZXkpIHsgZGVsZXRlIG9iamVjdFtrZXldOyB9KTtcbiAgICB9XG59O1xuXG4iLCJcbi8qKlxuICogXG4gKiBTZXJ2aWNlIHRoYXQgYWxsb3dzIGFuIGFycmF5IG9mIGRhdGEgcmVtYWluIGluIHN5bmMgd2l0aCBiYWNrZW5kLlxuICogXG4gKiBcbiAqIGV4OlxuICogd2hlbiB0aGVyZSBpcyBhIG5vdGlmaWNhdGlvbiwgbm90aWNhdGlvblNlcnZpY2Ugbm90aWZpZXMgdGhhdCB0aGVyZSBpcyBzb21ldGhpbmcgbmV3Li4udGhlbiB0aGUgZGF0YXNldCBnZXQgdGhlIGRhdGEgYW5kIG5vdGlmaWVzIGFsbCBpdHMgY2FsbGJhY2suXG4gKiBcbiAqIE5PVEU6IFxuICogIFxuICogXG4gKiBQcmUtUmVxdWlzdGU6XG4gKiAtLS0tLS0tLS0tLS0tXG4gKiBTeW5jIHJlcXVpcmVzIG9iamVjdHMgaGF2ZSBCT1RIIGlkIGFuZCByZXZpc2lvbiBmaWVsZHMvcHJvcGVydGllcy5cbiAqIFxuICogV2hlbiB0aGUgYmFja2VuZCB3cml0ZXMgYW55IGRhdGEgdG8gdGhlIGRiIHRoYXQgYXJlIHN1cHBvc2VkIHRvIGJlIHN5bmNyb25pemVkOlxuICogSXQgbXVzdCBtYWtlIHN1cmUgZWFjaCBhZGQsIHVwZGF0ZSwgcmVtb3ZhbCBvZiByZWNvcmQgaXMgdGltZXN0YW1wZWQuXG4gKiBJdCBtdXN0IG5vdGlmeSB0aGUgZGF0YXN0cmVhbSAod2l0aCBub3RpZnlDaGFuZ2Ugb3Igbm90aWZ5UmVtb3ZhbCkgd2l0aCBzb21lIHBhcmFtcyBzbyB0aGF0IGJhY2tlbmQga25vd3MgdGhhdCBpdCBoYXMgdG8gcHVzaCBiYWNrIHRoZSBkYXRhIGJhY2sgdG8gdGhlIHN1YnNjcmliZXJzIChleDogdGhlIHRhc2tDcmVhdGlvbiB3b3VsZCBub3RpZnkgd2l0aCBpdHMgcGxhbklkKVxuKiBcbiAqIFxuICovXG5hbmd1bGFyXG4gICAgLm1vZHVsZSgnc3luYycpXG4gICAgLnByb3ZpZGVyKCckc3luYycsIHN5bmNQcm92aWRlcik7XG5cbmZ1bmN0aW9uIHN5bmNQcm92aWRlcigpIHtcblxuICAgIHZhciBkZWJ1ZztcblxuICAgIHRoaXMuc2V0RGVidWcgPSBmdW5jdGlvbiAodmFsdWUpIHtcbiAgICAgICAgZGVidWcgPSB2YWx1ZTtcbiAgICB9O1xuXG4gICAgdGhpcy4kZ2V0ID0gZnVuY3Rpb24gc3luYygkcm9vdFNjb3BlLCAkcSwgJHNvY2tldGlvLCAkc3luY0dhcmJhZ2VDb2xsZWN0b3IsICRzeW5jTWVyZ2UpIHtcblxuICAgICAgICB2YXIgcHVibGljYXRpb25MaXN0ZW5lcnMgPSB7fSxcbiAgICAgICAgICAgIHB1YmxpY2F0aW9uTGlzdGVuZXJDb3VudCA9IDA7XG4gICAgICAgIHZhciBHUkFDRV9QRVJJT0RfSU5fU0VDT05EUyA9IDg7XG4gICAgICAgIHZhciBTWU5DX1ZFUlNJT04gPSAnMS4yJztcblxuXG4gICAgICAgIGxpc3RlblRvU3luY05vdGlmaWNhdGlvbigpO1xuXG4gICAgICAgIHZhciBzZXJ2aWNlID0ge1xuICAgICAgICAgICAgc3Vic2NyaWJlOiBzdWJzY3JpYmUsXG4gICAgICAgICAgICByZXNvbHZlU3Vic2NyaXB0aW9uOiByZXNvbHZlU3Vic2NyaXB0aW9uLFxuICAgICAgICAgICAgZ2V0R3JhY2VQZXJpb2Q6IGdldEdyYWNlUGVyaW9kLFxuICAgICAgICAgICAgZ2V0SWRWYWx1ZTogZ2V0SWRWYWx1ZVxuICAgICAgICB9O1xuXG4gICAgICAgIHJldHVybiBzZXJ2aWNlO1xuXG4gICAgICAgIC8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vXG4gICAgICAgIC8qKlxuICAgICAgICAgKiBzdWJzY3JpYmUgdG8gcHVibGljYXRpb24gYW5kIHJldHVybnMgdGhlIHN1YnNjcmlwdGlvbiB3aGVuIGRhdGEgaXMgYXZhaWxhYmxlLiBcbiAgICAgICAgICogQHBhcmFtIHB1YmxpY2F0aW9uIG5hbWUuIG9uIHRoZSBzZXJ2ZXIgc2lkZSwgYSBwdWJsaWNhdGlvbiBzaGFsbCBleGlzdC4gZXg6IG1hZ2F6aW5lcy5zeW5jXG4gICAgICAgICAqIEBwYXJhbSBwYXJhbXMgICB0aGUgcGFyYW1zIG9iamVjdCBwYXNzZWQgdG8gdGhlIHN1YnNjcmlwdGlvbiwgZXg6IHttYWdhemluZUlkOidlbnRyZXByZW5ldXInfSlcbiAgICAgICAgICogQHBhcmFtIG9iamVjdENsYXNzIGFuIGluc3RhbmNlIG9mIHRoaXMgY2xhc3Mgd2lsbCBiZSBjcmVhdGVkIGZvciBlYWNoIHJlY29yZCByZWNlaXZlZC5cbiAgICAgICAgICogcmV0dXJucyBhIHByb21pc2UgcmV0dXJuaW5nIHRoZSBzdWJzY3JpcHRpb24gd2hlbiB0aGUgZGF0YSBpcyBzeW5jZWRcbiAgICAgICAgICogb3IgcmVqZWN0cyBpZiB0aGUgaW5pdGlhbCBzeW5jIGZhaWxzIHRvIGNvbXBsZXRlIGluIGEgbGltaXRlZCBhbW91bnQgb2YgdGltZS4gXG4gICAgICAgICAqIFxuICAgICAgICAgKiB0byBnZXQgdGhlIGRhdGEgZnJvbSB0aGUgZGF0YVNldCwganVzdCBkYXRhU2V0LmdldERhdGEoKVxuICAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gcmVzb2x2ZVN1YnNjcmlwdGlvbihwdWJsaWNhdGlvbk5hbWUsIHBhcmFtcywgb2JqZWN0Q2xhc3MpIHtcbiAgICAgICAgICAgIHZhciBkZWZlcnJlZCA9ICRxLmRlZmVyKCk7XG4gICAgICAgICAgICB2YXIgc0RzID0gc3Vic2NyaWJlKHB1YmxpY2F0aW9uTmFtZSkuc2V0T2JqZWN0Q2xhc3Mob2JqZWN0Q2xhc3MpO1xuXG4gICAgICAgICAgICAvLyBnaXZlIGEgbGl0dGxlIHRpbWUgZm9yIHN1YnNjcmlwdGlvbiB0byBmZXRjaCB0aGUgZGF0YS4uLm90aGVyd2lzZSBnaXZlIHVwIHNvIHRoYXQgd2UgZG9uJ3QgZ2V0IHN0dWNrIGluIGEgcmVzb2x2ZSB3YWl0aW5nIGZvcmV2ZXIuXG4gICAgICAgICAgICB2YXIgZ3JhY2VQZXJpb2QgPSBzZXRUaW1lb3V0KGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICBpZiAoIXNEcy5yZWFkeSkge1xuICAgICAgICAgICAgICAgICAgICBzRHMuZGVzdHJveSgpO1xuICAgICAgICAgICAgICAgICAgICBsb2dJbmZvKCdBdHRlbXB0IHRvIHN1YnNjcmliZSB0byBwdWJsaWNhdGlvbiAnICsgcHVibGljYXRpb25OYW1lICsgJyBmYWlsZWQnKTtcbiAgICAgICAgICAgICAgICAgICAgZGVmZXJyZWQucmVqZWN0KCdTWU5DX1RJTUVPVVQnKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9LCBHUkFDRV9QRVJJT0RfSU5fU0VDT05EUyAqIDEwMDApO1xuXG4gICAgICAgICAgICBzRHMuc2V0UGFyYW1ldGVycyhwYXJhbXMpXG4gICAgICAgICAgICAgICAgLndhaXRGb3JEYXRhUmVhZHkoKVxuICAgICAgICAgICAgICAgIC50aGVuKGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICAgICAgY2xlYXJUaW1lb3V0KGdyYWNlUGVyaW9kKTtcbiAgICAgICAgICAgICAgICAgICAgZGVmZXJyZWQucmVzb2x2ZShzRHMpO1xuICAgICAgICAgICAgICAgIH0pLmNhdGNoKGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICAgICAgY2xlYXJUaW1lb3V0KGdyYWNlUGVyaW9kKTtcbiAgICAgICAgICAgICAgICAgICAgc0RzLmRlc3Ryb3koKTtcbiAgICAgICAgICAgICAgICAgICAgZGVmZXJyZWQucmVqZWN0KCdGYWlsZWQgdG8gc3Vic2NyaWJlIHRvIHB1YmxpY2F0aW9uICcgKyBwdWJsaWNhdGlvbk5hbWUgKyAnIGZhaWxlZCcpO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgcmV0dXJuIGRlZmVycmVkLnByb21pc2U7XG4gICAgICAgIH1cblxuICAgICAgICAvKipcbiAgICAgICAgICogXG4gICAgICAgICAqIGZvciB0ZXN0IHB1cnBvc2VzLCByZXR1cm5zIHRoZSB0aW1lIHJlc29sdmVTdWJzY3JpcHRpb24gYmVmb3JlIGl0IHRpbWVzIG91dC5cbiAgICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIGdldEdyYWNlUGVyaW9kKCkge1xuICAgICAgICAgICAgcmV0dXJuIEdSQUNFX1BFUklPRF9JTl9TRUNPTkRTO1xuICAgICAgICB9XG4gICAgICAgIC8qKlxuICAgICAgICAgKiBzdWJzY3JpYmUgdG8gcHVibGljYXRpb24uIEl0IHdpbGwgbm90IHN5bmMgdW50aWwgeW91IHNldCB0aGUgcGFyYW1zLlxuICAgICAgICAgKiBcbiAgICAgICAgICogQHBhcmFtIHB1YmxpY2F0aW9uIG5hbWUuIG9uIHRoZSBzZXJ2ZXIgc2lkZSwgYSBwdWJsaWNhdGlvbiBzaGFsbCBleGlzdC4gZXg6IG1hZ2F6aW5lcy5zeW5jXG4gICAgICAgICAqIEBwYXJhbSBwYXJhbXMgICB0aGUgcGFyYW1zIG9iamVjdCBwYXNzZWQgdG8gdGhlIHN1YnNjcmlwdGlvbiwgZXg6IHttYWdhemluZUlkOidlbnRyZXByZW5ldXInfSlcbiAgICAgICAgICogcmV0dXJucyBzdWJzY3JpcHRpb25cbiAgICAgICAgICogXG4gICAgICAgICAqL1xuICAgICAgICBmdW5jdGlvbiBzdWJzY3JpYmUocHVibGljYXRpb25OYW1lLCBzY29wZSkge1xuICAgICAgICAgICAgcmV0dXJuIG5ldyBTdWJzY3JpcHRpb24ocHVibGljYXRpb25OYW1lLCBzY29wZSk7XG4gICAgICAgIH1cblxuXG5cbiAgICAgICAgLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy9cbiAgICAgICAgLy8gSEVMUEVSU1xuXG4gICAgICAgIC8vIGV2ZXJ5IHN5bmMgbm90aWZpY2F0aW9uIGNvbWVzIHRocnUgdGhlIHNhbWUgZXZlbnQgdGhlbiBpdCBpcyBkaXNwYXRjaGVzIHRvIHRoZSB0YXJnZXRlZCBzdWJzY3JpcHRpb25zLlxuICAgICAgICBmdW5jdGlvbiBsaXN0ZW5Ub1N5bmNOb3RpZmljYXRpb24oKSB7XG4gICAgICAgICAgICAkc29ja2V0aW8ub24oJ1NZTkNfTk9XJywgZnVuY3Rpb24gKHN1Yk5vdGlmaWNhdGlvbiwgZm4pIHtcbiAgICAgICAgICAgICAgICBsb2dJbmZvKCdTeW5jaW5nIHdpdGggc3Vic2NyaXB0aW9uIFtuYW1lOicgKyBzdWJOb3RpZmljYXRpb24ubmFtZSArICcsIGlkOicgKyBzdWJOb3RpZmljYXRpb24uc3Vic2NyaXB0aW9uSWQgKyAnICwgcGFyYW1zOicgKyBKU09OLnN0cmluZ2lmeShzdWJOb3RpZmljYXRpb24ucGFyYW1zKSArICddLiBSZWNvcmRzOicgKyBzdWJOb3RpZmljYXRpb24ucmVjb3Jkcy5sZW5ndGggKyAnWycgKyAoc3ViTm90aWZpY2F0aW9uLmRpZmYgPyAnRGlmZicgOiAnQWxsJykgKyAnXScpO1xuICAgICAgICAgICAgICAgIHZhciBsaXN0ZW5lcnMgPSBwdWJsaWNhdGlvbkxpc3RlbmVyc1tzdWJOb3RpZmljYXRpb24ubmFtZV07XG4gICAgICAgICAgICAgICAgaWYgKGxpc3RlbmVycykge1xuICAgICAgICAgICAgICAgICAgICBmb3IgKHZhciBsaXN0ZW5lciBpbiBsaXN0ZW5lcnMpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxpc3RlbmVyc1tsaXN0ZW5lcl0oc3ViTm90aWZpY2F0aW9uKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBmbignU1lOQ0VEJyk7IC8vIGxldCBrbm93IHRoZSBiYWNrZW5kIHRoZSBjbGllbnQgd2FzIGFibGUgdG8gc3luYy5cbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9O1xuXG5cbiAgICAgICAgLy8gdGhpcyBhbGxvd3MgYSBkYXRhc2V0IHRvIGxpc3RlbiB0byBhbnkgU1lOQ19OT1cgZXZlbnQuLmFuZCBpZiB0aGUgbm90aWZpY2F0aW9uIGlzIGFib3V0IGl0cyBkYXRhLlxuICAgICAgICBmdW5jdGlvbiBhZGRQdWJsaWNhdGlvbkxpc3RlbmVyKHN0cmVhbU5hbWUsIGNhbGxiYWNrKSB7XG4gICAgICAgICAgICB2YXIgdWlkID0gcHVibGljYXRpb25MaXN0ZW5lckNvdW50Kys7XG4gICAgICAgICAgICB2YXIgbGlzdGVuZXJzID0gcHVibGljYXRpb25MaXN0ZW5lcnNbc3RyZWFtTmFtZV07XG4gICAgICAgICAgICBpZiAoIWxpc3RlbmVycykge1xuICAgICAgICAgICAgICAgIHB1YmxpY2F0aW9uTGlzdGVuZXJzW3N0cmVhbU5hbWVdID0gbGlzdGVuZXJzID0ge307XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBsaXN0ZW5lcnNbdWlkXSA9IGNhbGxiYWNrO1xuXG4gICAgICAgICAgICByZXR1cm4gZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgIGRlbGV0ZSBsaXN0ZW5lcnNbdWlkXTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAgICAgLy8gU3Vic2NyaXB0aW9uIG9iamVjdFxuICAgICAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAgICAgLyoqXG4gICAgICAgICAqIGEgc3Vic2NyaXB0aW9uIHN5bmNocm9uaXplcyB3aXRoIHRoZSBiYWNrZW5kIGZvciBhbnkgYmFja2VuZCBkYXRhIGNoYW5nZSBhbmQgbWFrZXMgdGhhdCBkYXRhIGF2YWlsYWJsZSB0byBhIGNvbnRyb2xsZXIuXG4gICAgICAgICAqIFxuICAgICAgICAgKiAgV2hlbiBjbGllbnQgc3Vic2NyaWJlcyB0byBhbiBzeW5jcm9uaXplZCBhcGksIGFueSBkYXRhIGNoYW5nZSB0aGF0IGltcGFjdHMgdGhlIGFwaSByZXN1bHQgV0lMTCBiZSBQVVNIZWQgdG8gdGhlIGNsaWVudC5cbiAgICAgICAgICogSWYgdGhlIGNsaWVudCBkb2VzIE5PVCBzdWJzY3JpYmUgb3Igc3RvcCBzdWJzY3JpYmUsIGl0IHdpbGwgbm8gbG9uZ2VyIHJlY2VpdmUgdGhlIFBVU0guIFxuICAgICAgICAgKiAgICBcbiAgICAgICAgICogaWYgdGhlIGNvbm5lY3Rpb24gaXMgbG9zdCBmb3IgYSBzaG9ydCB0aW1lIChkdXJhdGlvbiBkZWZpbmVkIG9uIHNlcnZlci1zaWRlKSwgdGhlIHNlcnZlciBxdWV1ZXMgdGhlIGNoYW5nZXMgaWYgYW55LiBcbiAgICAgICAgICogV2hlbiB0aGUgY29ubmVjdGlvbiByZXR1cm5zLCB0aGUgbWlzc2luZyBkYXRhIGF1dG9tYXRpY2FsbHkgIHdpbGwgYmUgUFVTSGVkIHRvIHRoZSBzdWJzY3JpYmluZyBjbGllbnQuXG4gICAgICAgICAqIGlmIHRoZSBjb25uZWN0aW9uIGlzIGxvc3QgZm9yIGEgbG9uZyB0aW1lIChkdXJhdGlvbiBkZWZpbmVkIG9uIHRoZSBzZXJ2ZXIpLCB0aGUgc2VydmVyIHdpbGwgZGVzdHJveSB0aGUgc3Vic2NyaXB0aW9uLiBUbyBzaW1wbGlmeSwgdGhlIGNsaWVudCB3aWxsIHJlc3Vic2NyaWJlIGF0IGl0cyByZWNvbm5lY3Rpb24gYW5kIGdldCBhbGwgZGF0YS5cbiAgICAgICAgICogXG4gICAgICAgICAqIHN1YnNjcmlwdGlvbiBvYmplY3QgcHJvdmlkZXMgMyBjYWxsYmFja3MgKGFkZCx1cGRhdGUsIGRlbCkgd2hpY2ggYXJlIGNhbGxlZCBkdXJpbmcgc3luY2hyb25pemF0aW9uLlxuICAgICAgICAgKiAgICAgIFxuICAgICAgICAgKiBTY29wZSB3aWxsIGFsbG93IHRoZSBzdWJzY3JpcHRpb24gc3RvcCBzeW5jaHJvbml6aW5nIGFuZCBjYW5jZWwgcmVnaXN0cmF0aW9uIHdoZW4gaXQgaXMgZGVzdHJveWVkLiBcbiAgICAgICAgICogIFxuICAgICAgICAgKiBDb25zdHJ1Y3RvcjpcbiAgICAgICAgICogXG4gICAgICAgICAqIEBwYXJhbSBwdWJsaWNhdGlvbiwgdGhlIHB1YmxpY2F0aW9uIG11c3QgZXhpc3Qgb24gdGhlIHNlcnZlciBzaWRlXG4gICAgICAgICAqIEBwYXJhbSBzY29wZSwgYnkgZGVmYXVsdCAkcm9vdFNjb3BlLCBidXQgY2FuIGJlIG1vZGlmaWVkIGxhdGVyIG9uIHdpdGggYXR0YWNoIG1ldGhvZC5cbiAgICAgICAgICovXG5cbiAgICAgICAgZnVuY3Rpb24gU3Vic2NyaXB0aW9uKHB1YmxpY2F0aW9uLCBzY29wZSkge1xuICAgICAgICAgICAgdmFyIHRpbWVzdGFtcEZpZWxkLCBpc1N5bmNpbmdPbiA9IGZhbHNlLCBpc1NpbmdsZSwgdXBkYXRlRGF0YVN0b3JhZ2UsIGNhY2hlLCBpc0luaXRpYWxQdXNoQ29tcGxldGVkLCBkZWZlcnJlZEluaXRpYWxpemF0aW9uLCBzdHJpY3RNb2RlO1xuICAgICAgICAgICAgdmFyIG9uUmVhZHlPZmYsIGZvcm1hdFJlY29yZDtcbiAgICAgICAgICAgIHZhciByZWNvbm5lY3RPZmYsIHB1YmxpY2F0aW9uTGlzdGVuZXJPZmYsIGRlc3Ryb3lPZmY7XG4gICAgICAgICAgICB2YXIgb2JqZWN0Q2xhc3M7XG4gICAgICAgICAgICB2YXIgc3Vic2NyaXB0aW9uSWQ7XG5cbiAgICAgICAgICAgIHZhciBzRHMgPSB0aGlzO1xuICAgICAgICAgICAgdmFyIHN1YlBhcmFtcyA9IHt9O1xuICAgICAgICAgICAgdmFyIHJlY29yZFN0YXRlcyA9IHt9O1xuICAgICAgICAgICAgdmFyIGlubmVyU2NvcGU7Ly89ICRyb290U2NvcGUuJG5ldyh0cnVlKTtcbiAgICAgICAgICAgIHZhciBzeW5jTGlzdGVuZXIgPSBuZXcgU3luY0xpc3RlbmVyKCk7XG5cblxuICAgICAgICAgICAgdGhpcy5yZWFkeSA9IGZhbHNlO1xuICAgICAgICAgICAgdGhpcy5zeW5jT24gPSBzeW5jT247XG4gICAgICAgICAgICB0aGlzLnN5bmNPZmYgPSBzeW5jT2ZmO1xuICAgICAgICAgICAgdGhpcy5zZXRPblJlYWR5ID0gc2V0T25SZWFkeTtcblxuICAgICAgICAgICAgdGhpcy5vblJlYWR5ID0gb25SZWFkeTtcbiAgICAgICAgICAgIHRoaXMub25VcGRhdGUgPSBvblVwZGF0ZTtcbiAgICAgICAgICAgIHRoaXMub25BZGQgPSBvbkFkZDtcbiAgICAgICAgICAgIHRoaXMub25SZW1vdmUgPSBvblJlbW92ZTtcblxuICAgICAgICAgICAgdGhpcy5nZXREYXRhID0gZ2V0RGF0YTtcbiAgICAgICAgICAgIHRoaXMuc2V0UGFyYW1ldGVycyA9IHNldFBhcmFtZXRlcnM7XG5cbiAgICAgICAgICAgIHRoaXMud2FpdEZvckRhdGFSZWFkeSA9IHdhaXRGb3JEYXRhUmVhZHk7XG4gICAgICAgICAgICB0aGlzLndhaXRGb3JTdWJzY3JpcHRpb25SZWFkeSA9IHdhaXRGb3JTdWJzY3JpcHRpb25SZWFkeTtcblxuICAgICAgICAgICAgdGhpcy5zZXRGb3JjZSA9IHNldEZvcmNlO1xuICAgICAgICAgICAgdGhpcy5pc1N5bmNpbmcgPSBpc1N5bmNpbmc7XG4gICAgICAgICAgICB0aGlzLmlzUmVhZHkgPSBpc1JlYWR5O1xuXG4gICAgICAgICAgICB0aGlzLnNldFNpbmdsZSA9IHNldFNpbmdsZTtcblxuICAgICAgICAgICAgdGhpcy5zZXRPYmplY3RDbGFzcyA9IHNldE9iamVjdENsYXNzO1xuICAgICAgICAgICAgdGhpcy5nZXRPYmplY3RDbGFzcyA9IGdldE9iamVjdENsYXNzO1xuXG4gICAgICAgICAgICB0aGlzLnNldFN0cmljdE1vZGUgPSBzZXRTdHJpY3RNb2RlO1xuXG4gICAgICAgICAgICB0aGlzLmF0dGFjaCA9IGF0dGFjaDtcbiAgICAgICAgICAgIHRoaXMuZGVzdHJveSA9IGRlc3Ryb3k7XG5cbiAgICAgICAgICAgIHRoaXMuaXNFeGlzdGluZ1N0YXRlRm9yID0gaXNFeGlzdGluZ1N0YXRlRm9yOyAvLyBmb3IgdGVzdGluZyBwdXJwb3Nlc1xuXG4gICAgICAgICAgICBzZXRTaW5nbGUoZmFsc2UpO1xuXG4gICAgICAgICAgICAvLyB0aGlzIHdpbGwgbWFrZSBzdXJlIHRoYXQgdGhlIHN1YnNjcmlwdGlvbiBpcyByZWxlYXNlZCBmcm9tIHNlcnZlcnMgaWYgdGhlIGFwcCBjbG9zZXMgKGNsb3NlIGJyb3dzZXIsIHJlZnJlc2guLi4pXG4gICAgICAgICAgICBhdHRhY2goc2NvcGUgfHwgJHJvb3RTY29wZSk7XG5cbiAgICAgICAgICAgIC8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy9cblxuICAgICAgICAgICAgZnVuY3Rpb24gZGVzdHJveSgpIHtcbiAgICAgICAgICAgICAgICBzeW5jT2ZmKCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKiB0aGlzIHdpbGwgYmUgY2FsbGVkIHdoZW4gZGF0YSBpcyBhdmFpbGFibGUgXG4gICAgICAgICAgICAgKiAgaXQgbWVhbnMgcmlnaHQgYWZ0ZXIgZWFjaCBzeW5jIVxuICAgICAgICAgICAgICogXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBzZXRPblJlYWR5KGNhbGxiYWNrKSB7XG4gICAgICAgICAgICAgICAgaWYgKG9uUmVhZHlPZmYpIHtcbiAgICAgICAgICAgICAgICAgICAgb25SZWFkeU9mZigpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBvblJlYWR5T2ZmID0gb25SZWFkeShjYWxsYmFjayk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgKiBmb3JjZSByZXN5bmNpbmcgZnJvbSBzY3JhdGNoIGV2ZW4gaWYgdGhlIHBhcmFtZXRlcnMgaGF2ZSBub3QgY2hhbmdlZFxuICAgICAgICAgICAgICogXG4gICAgICAgICAgICAgKiBpZiBvdXRzaWRlIGNvZGUgaGFzIG1vZGlmaWVkIHRoZSBkYXRhIGFuZCB5b3UgbmVlZCB0byByb2xsYmFjaywgeW91IGNvdWxkIGNvbnNpZGVyIGZvcmNpbmcgYSByZWZyZXNoIHdpdGggdGhpcy4gQmV0dGVyIHNvbHV0aW9uIHNob3VsZCBiZSBmb3VuZCB0aGFuIHRoYXQuXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICAqL1xuICAgICAgICAgICAgZnVuY3Rpb24gc2V0Rm9yY2UodmFsdWUpIHtcbiAgICAgICAgICAgICAgICBpZiAodmFsdWUpIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gcXVpY2sgaGFjayB0byBmb3JjZSB0byByZWxvYWQuLi5yZWNvZGUgbGF0ZXIuXG4gICAgICAgICAgICAgICAgICAgIHNEcy5zeW5jT2ZmKCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogaWYgc2V0IHRvIHRydWUsIGlmIGFuIG9iamVjdCB3aXRoaW4gYW4gYXJyYXkgcHJvcGVydHkgb2YgdGhlIHJlY29yZCB0byBzeW5jIGhhcyBubyBJRCBmaWVsZC5cbiAgICAgICAgICAgICAqIGFuIGVycm9yIHdvdWxkIGJlIHRocm93bi5cbiAgICAgICAgICAgICAqIEl0IGlzIGltcG9ydGFudCBpZiB3ZSB3YW50IHRvIGJlIGFibGUgdG8gbWFpbnRhaW4gaW5zdGFuY2UgcmVmZXJlbmNlcyBldmVuIGZvciB0aGUgb2JqZWN0cyBpbnNpZGUgYXJyYXlzLlxuICAgICAgICAgICAgICpcbiAgICAgICAgICAgICAqIEZvcmNlcyB1cyB0byB1c2UgaWQgZXZlcnkgd2hlcmUuXG4gICAgICAgICAgICAgKlxuICAgICAgICAgICAgICogU2hvdWxkIGJlIHRoZSBkZWZhdWx0Li4uYnV0IHRvbyByZXN0cmljdGl2ZSBmb3Igbm93LlxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBzZXRTdHJpY3RNb2RlKHZhbHVlKSB7XG4gICAgICAgICAgICAgICAgc3RyaWN0TW9kZSA9IHZhbHVlO1xuICAgICAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogVGhlIGZvbGxvd2luZyBvYmplY3Qgd2lsbCBiZSBidWlsdCB1cG9uIGVhY2ggcmVjb3JkIHJlY2VpdmVkIGZyb20gdGhlIGJhY2tlbmRcbiAgICAgICAgICAgICAqIFxuICAgICAgICAgICAgICogVGhpcyBjYW5ub3QgYmUgbW9kaWZpZWQgYWZ0ZXIgdGhlIHN5bmMgaGFzIHN0YXJ0ZWQuXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICAqIEBwYXJhbSBjbGFzc1ZhbHVlXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIHNldE9iamVjdENsYXNzKGNsYXNzVmFsdWUpIHtcbiAgICAgICAgICAgICAgICBpZiAoZGVmZXJyZWRJbml0aWFsaXphdGlvbikge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIG9iamVjdENsYXNzID0gY2xhc3NWYWx1ZTtcbiAgICAgICAgICAgICAgICBmb3JtYXRSZWNvcmQgPSBmdW5jdGlvbiAocmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBuZXcgb2JqZWN0Q2xhc3MocmVjb3JkKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgc2V0U2luZ2xlKGlzU2luZ2xlKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBnZXRPYmplY3RDbGFzcygpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gb2JqZWN0Q2xhc3M7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogdGhpcyBmdW5jdGlvbiBzdGFydHMgdGhlIHN5bmNpbmcuXG4gICAgICAgICAgICAgKiBPbmx5IHB1YmxpY2F0aW9uIHB1c2hpbmcgZGF0YSBtYXRjaGluZyBvdXIgZmV0Y2hpbmcgcGFyYW1zIHdpbGwgYmUgcmVjZWl2ZWQuXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICAqIGV4OiBmb3IgYSBwdWJsaWNhdGlvbiBuYW1lZCBcIm1hZ2F6aW5lcy5zeW5jXCIsIGlmIGZldGNoaW5nIHBhcmFtcyBlcXVhbGxlZCB7bWFnYXppbk5hbWU6J2NhcnMnfSwgdGhlIG1hZ2F6aW5lIGNhcnMgZGF0YSB3b3VsZCBiZSByZWNlaXZlZCBieSB0aGlzIHN1YnNjcmlwdGlvbi5cbiAgICAgICAgICAgICAqIFxuICAgICAgICAgICAgICogQHBhcmFtIGZldGNoaW5nUGFyYW1zXG4gICAgICAgICAgICAgKiBAcGFyYW0gb3B0aW9uc1xuICAgICAgICAgICAgICogXG4gICAgICAgICAgICAgKiBAcmV0dXJucyBhIHByb21pc2UgdGhhdCByZXNvbHZlcyB3aGVuIGRhdGEgaXMgYXJyaXZlZC5cbiAgICAgICAgICAgICAqL1xuICAgICAgICAgICAgZnVuY3Rpb24gc2V0UGFyYW1ldGVycyhmZXRjaGluZ1BhcmFtcywgb3B0aW9ucykge1xuICAgICAgICAgICAgICAgIGlmIChpc1N5bmNpbmdPbiAmJiBhbmd1bGFyLmVxdWFscyhmZXRjaGluZ1BhcmFtcyB8fCB7fSwgc3ViUGFyYW1zKSkge1xuICAgICAgICAgICAgICAgICAgICAvLyBpZiB0aGUgcGFyYW1zIGhhdmUgbm90IGNoYW5nZWQsIGp1c3QgcmV0dXJucyB3aXRoIGN1cnJlbnQgZGF0YS5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHNEczsgLy8kcS5yZXNvbHZlKGdldERhdGEoKSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHN5bmNPZmYoKTtcbiAgICAgICAgICAgICAgICBpZiAoIWlzU2luZ2xlKSB7XG4gICAgICAgICAgICAgICAgICAgIGNhY2hlLmxlbmd0aCA9IDA7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgc3ViUGFyYW1zID0gZmV0Y2hpbmdQYXJhbXMgfHwge307XG4gICAgICAgICAgICAgICAgb3B0aW9ucyA9IG9wdGlvbnMgfHwge307XG4gICAgICAgICAgICAgICAgaWYgKGFuZ3VsYXIuaXNEZWZpbmVkKG9wdGlvbnMuc2luZ2xlKSkge1xuICAgICAgICAgICAgICAgICAgICBzZXRTaW5nbGUob3B0aW9ucy5zaW5nbGUpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBzdGFydFN5bmNpbmcoKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqIEByZXR1cm5zIGEgcHJvbWlzZSB0aGF0IHdhaXRzIGZvciB0aGUgaW5pdGlhbCBmZXRjaCB0byBjb21wbGV0ZSB0aGVuIHdhaXQgZm9yIHRoZSBpbml0aWFsIGZldGNoIHRvIGNvbXBsZXRlIHRoZW4gcmV0dXJucyB0aGlzIHN1YnNjcmlwdGlvbi5cbiAgICAgICAgICAgICAqL1xuICAgICAgICAgICAgZnVuY3Rpb24gd2FpdEZvclN1YnNjcmlwdGlvblJlYWR5KCkge1xuICAgICAgICAgICAgICAgIHJldHVybiBzdGFydFN5bmNpbmcoKS50aGVuKGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgKiBAcmV0dXJucyBhIHByb21pc2UgdGhhdCB3YWl0cyBmb3IgdGhlIGluaXRpYWwgZmV0Y2ggdG8gY29tcGxldGUgdGhlbiByZXR1cm5zIHRoZSBkYXRhXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIHdhaXRGb3JEYXRhUmVhZHkoKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHN0YXJ0U3luY2luZygpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyBkb2VzIHRoZSBkYXRhc2V0IHJldHVybnMgb25seSBvbmUgb2JqZWN0PyBub3QgYW4gYXJyYXk/XG4gICAgICAgICAgICBmdW5jdGlvbiBzZXRTaW5nbGUodmFsdWUpIHtcbiAgICAgICAgICAgICAgICBpZiAoZGVmZXJyZWRJbml0aWFsaXphdGlvbikge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHZhciB1cGRhdGVGbjtcbiAgICAgICAgICAgICAgICBpc1NpbmdsZSA9IHZhbHVlO1xuICAgICAgICAgICAgICAgIGlmICh2YWx1ZSkge1xuICAgICAgICAgICAgICAgICAgICB1cGRhdGVGbiA9IHVwZGF0ZVN5bmNlZE9iamVjdDtcbiAgICAgICAgICAgICAgICAgICAgY2FjaGUgPSBvYmplY3RDbGFzcyA/IG5ldyBvYmplY3RDbGFzcyh7fSkgOiB7fTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICB1cGRhdGVGbiA9IHVwZGF0ZVN5bmNlZEFycmF5O1xuICAgICAgICAgICAgICAgICAgICBjYWNoZSA9IFtdO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHVwZGF0ZURhdGFTdG9yYWdlID0gZnVuY3Rpb24gKHJlY29yZCkge1xuICAgICAgICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdXBkYXRlRm4ocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgZS5tZXNzYWdlID0gJ1JlY2VpdmVkIEludmFsaWQgb2JqZWN0IGZyb20gcHVibGljYXRpb24gWycgKyBwdWJsaWNhdGlvbiArICddOiAnICsgSlNPTi5zdHJpbmdpZnkocmVjb3JkKSArICcuIERFVEFJTFM6ICcgKyBlLm1lc3NhZ2U7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBlO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy8gcmV0dXJucyB0aGUgb2JqZWN0IG9yIGFycmF5IGluIHN5bmNcbiAgICAgICAgICAgIGZ1bmN0aW9uIGdldERhdGEoKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGNhY2hlO1xuICAgICAgICAgICAgfVxuXG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogQWN0aXZhdGUgc3luY2luZ1xuICAgICAgICAgICAgICpcbiAgICAgICAgICAgICAqIEByZXR1cm5zIHRoaXMgc3ViY3JpcHRpb25cbiAgICAgICAgICAgICAqXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIHN5bmNPbigpIHtcbiAgICAgICAgICAgICAgICBzdGFydFN5bmNpbmcoKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICAgICAgfVxuXG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogRGVhY3RpdmF0ZSBzeW5jaW5nXG4gICAgICAgICAgICAgKlxuICAgICAgICAgICAgICogdGhlIGRhdGFzZXQgaXMgbm8gbG9uZ2VyIGxpc3RlbmluZyBhbmQgd2lsbCBub3QgY2FsbCBhbnkgY2FsbGJhY2tcbiAgICAgICAgICAgICAqXG4gICAgICAgICAgICAgKiBAcmV0dXJucyB0aGlzIHN1YmNyaXB0aW9uXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIHN5bmNPZmYoKSB7XG4gICAgICAgICAgICAgICAgaWYgKGRlZmVycmVkSW5pdGlhbGl6YXRpb24pIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gaWYgdGhlcmUgaXMgY29kZSB3YWl0aW5nIG9uIHRoaXMgcHJvbWlzZS4uIGV4IChsb2FkIGluIHJlc29sdmUpXG4gICAgICAgICAgICAgICAgICAgIGRlZmVycmVkSW5pdGlhbGl6YXRpb24ucmVzb2x2ZShnZXREYXRhKCkpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBpZiAoaXNTeW5jaW5nT24pIHtcbiAgICAgICAgICAgICAgICAgICAgdW5yZWdpc3RlclN1YnNjcmlwdGlvbigpO1xuICAgICAgICAgICAgICAgICAgICBpc1N5bmNpbmdPbiA9IGZhbHNlO1xuXG4gICAgICAgICAgICAgICAgICAgIGxvZ0luZm8oJ1N5bmMgJyArIHB1YmxpY2F0aW9uICsgJyBvZmYuIFBhcmFtczonICsgSlNPTi5zdHJpbmdpZnkoc3ViUGFyYW1zKSk7XG4gICAgICAgICAgICAgICAgICAgIGlmIChwdWJsaWNhdGlvbkxpc3RlbmVyT2ZmKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBwdWJsaWNhdGlvbkxpc3RlbmVyT2ZmKCk7XG4gICAgICAgICAgICAgICAgICAgICAgICBwdWJsaWNhdGlvbkxpc3RlbmVyT2ZmID0gbnVsbDtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBpZiAocmVjb25uZWN0T2ZmKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZWNvbm5lY3RPZmYoKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJlY29ubmVjdE9mZiA9IG51bGw7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgKiB0aGUgZGF0YXNldCB3aWxsIHN0YXJ0IGxpc3RlbmluZyB0byB0aGUgZGF0YXN0cmVhbSBcbiAgICAgICAgICAgICAqIFxuICAgICAgICAgICAgICogTm90ZSBEdXJpbmcgdGhlIHN5bmMsIGl0IHdpbGwgYWxzbyBjYWxsIHRoZSBvcHRpb25hbCBjYWxsYmFja3MgLSBhZnRlciBwcm9jZXNzaW5nIEVBQ0ggcmVjb3JkIHJlY2VpdmVkLlxuICAgICAgICAgICAgICogXG4gICAgICAgICAgICAgKiBAcmV0dXJucyBhIHByb21pc2UgdGhhdCB3aWxsIGJlIHJlc29sdmVkIHdoZW4gdGhlIGRhdGEgaXMgcmVhZHkuXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIHN0YXJ0U3luY2luZygpIHtcbiAgICAgICAgICAgICAgICBpZiAoaXNTeW5jaW5nT24pIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGRlZmVycmVkSW5pdGlhbGl6YXRpb24ucHJvbWlzZTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgZGVmZXJyZWRJbml0aWFsaXphdGlvbiA9ICRxLmRlZmVyKCk7XG4gICAgICAgICAgICAgICAgaXNJbml0aWFsUHVzaENvbXBsZXRlZCA9IGZhbHNlO1xuICAgICAgICAgICAgICAgIGxvZ0luZm8oJ1N5bmMgJyArIHB1YmxpY2F0aW9uICsgJyBvbi4gUGFyYW1zOicgKyBKU09OLnN0cmluZ2lmeShzdWJQYXJhbXMpKTtcbiAgICAgICAgICAgICAgICBpc1N5bmNpbmdPbiA9IHRydWU7XG4gICAgICAgICAgICAgICAgcmVnaXN0ZXJTdWJzY3JpcHRpb24oKTtcbiAgICAgICAgICAgICAgICByZWFkeUZvckxpc3RlbmluZygpO1xuICAgICAgICAgICAgICAgIHJldHVybiBkZWZlcnJlZEluaXRpYWxpemF0aW9uLnByb21pc2U7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIGlzU3luY2luZygpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gaXNTeW5jaW5nT247XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIHJlYWR5Rm9yTGlzdGVuaW5nKCkge1xuICAgICAgICAgICAgICAgIGlmICghcHVibGljYXRpb25MaXN0ZW5lck9mZikge1xuICAgICAgICAgICAgICAgICAgICBsaXN0ZW5Gb3JSZWNvbm5lY3Rpb25Ub1Jlc3luYygpO1xuICAgICAgICAgICAgICAgICAgICBsaXN0ZW5Ub1B1YmxpY2F0aW9uKCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqICBCeSBkZWZhdWx0IHRoZSByb290c2NvcGUgaXMgYXR0YWNoZWQgaWYgbm8gc2NvcGUgd2FzIHByb3ZpZGVkLiBCdXQgaXQgaXMgcG9zc2libGUgdG8gcmUtYXR0YWNoIGl0IHRvIGEgZGlmZmVyZW50IHNjb3BlLiBpZiB0aGUgc3Vic2NyaXB0aW9uIGRlcGVuZHMgb24gYSBjb250cm9sbGVyLlxuICAgICAgICAgICAgICpcbiAgICAgICAgICAgICAqICBEbyBub3QgYXR0YWNoIGFmdGVyIGl0IGhhcyBzeW5jZWQuXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIGF0dGFjaChuZXdTY29wZSkge1xuICAgICAgICAgICAgICAgIGlmIChkZWZlcnJlZEluaXRpYWxpemF0aW9uKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGlmIChkZXN0cm95T2ZmKSB7XG4gICAgICAgICAgICAgICAgICAgIGRlc3Ryb3lPZmYoKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgaW5uZXJTY29wZSA9IG5ld1Njb3BlO1xuICAgICAgICAgICAgICAgIGRlc3Ryb3lPZmYgPSBpbm5lclNjb3BlLiRvbignJGRlc3Ryb3knLCBkZXN0cm95KTtcblxuICAgICAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIGxpc3RlbkZvclJlY29ubmVjdGlvblRvUmVzeW5jKGxpc3Rlbk5vdykge1xuICAgICAgICAgICAgICAgIC8vIGdpdmUgYSBjaGFuY2UgdG8gY29ubmVjdCBiZWZvcmUgbGlzdGVuaW5nIHRvIHJlY29ubmVjdGlvbi4uLiBAVE9ETyBzaG91bGQgaGF2ZSB1c2VyX3JlY29ubmVjdGVkX2V2ZW50XG4gICAgICAgICAgICAgICAgc2V0VGltZW91dChmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgICAgIHJlY29ubmVjdE9mZiA9IGlubmVyU2NvcGUuJG9uKCd1c2VyX2Nvbm5lY3RlZCcsIGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxvZ0RlYnVnKCdSZXN5bmNpbmcgYWZ0ZXIgbmV0d29yayBsb3NzIHRvICcgKyBwdWJsaWNhdGlvbik7XG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBub3RlIHRoZSBiYWNrZW5kIG1pZ2h0IHJldHVybiBhIG5ldyBzdWJzY3JpcHRpb24gaWYgdGhlIGNsaWVudCB0b29rIHRvbyBtdWNoIHRpbWUgdG8gcmVjb25uZWN0LlxuICAgICAgICAgICAgICAgICAgICAgICAgcmVnaXN0ZXJTdWJzY3JpcHRpb24oKTtcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfSwgbGlzdGVuTm93ID8gMCA6IDIwMDApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiByZWdpc3RlclN1YnNjcmlwdGlvbigpIHtcbiAgICAgICAgICAgICAgICAkc29ja2V0aW8uZmV0Y2goJ3N5bmMuc3Vic2NyaWJlJywge1xuICAgICAgICAgICAgICAgICAgICB2ZXJzaW9uOiBTWU5DX1ZFUlNJT04sXG4gICAgICAgICAgICAgICAgICAgIGlkOiBzdWJzY3JpcHRpb25JZCwgLy8gdG8gdHJ5IHRvIHJlLXVzZSBleGlzdGluZyBzdWJjcmlwdGlvblxuICAgICAgICAgICAgICAgICAgICBwdWJsaWNhdGlvbjogcHVibGljYXRpb24sXG4gICAgICAgICAgICAgICAgICAgIHBhcmFtczogc3ViUGFyYW1zXG4gICAgICAgICAgICAgICAgfSkudGhlbihmdW5jdGlvbiAoc3ViSWQpIHtcbiAgICAgICAgICAgICAgICAgICAgc3Vic2NyaXB0aW9uSWQgPSBzdWJJZDtcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gdW5yZWdpc3RlclN1YnNjcmlwdGlvbigpIHtcbiAgICAgICAgICAgICAgICBpZiAoc3Vic2NyaXB0aW9uSWQpIHtcbiAgICAgICAgICAgICAgICAgICAgJHNvY2tldGlvLmZldGNoKCdzeW5jLnVuc3Vic2NyaWJlJywge1xuICAgICAgICAgICAgICAgICAgICAgICAgdmVyc2lvbjogU1lOQ19WRVJTSU9OLFxuICAgICAgICAgICAgICAgICAgICAgICAgaWQ6IHN1YnNjcmlwdGlvbklkXG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICBzdWJzY3JpcHRpb25JZCA9IG51bGw7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBsaXN0ZW5Ub1B1YmxpY2F0aW9uKCkge1xuICAgICAgICAgICAgICAgIC8vIGNhbm5vdCBvbmx5IGxpc3RlbiB0byBzdWJzY3JpcHRpb25JZCB5ZXQuLi5iZWNhdXNlIHRoZSByZWdpc3RyYXRpb24gbWlnaHQgaGF2ZSBhbnN3ZXIgcHJvdmlkZWQgaXRzIGlkIHlldC4uLmJ1dCBzdGFydGVkIGJyb2FkY2FzdGluZyBjaGFuZ2VzLi4uQFRPRE8gY2FuIGJlIGltcHJvdmVkLi4uXG4gICAgICAgICAgICAgICAgcHVibGljYXRpb25MaXN0ZW5lck9mZiA9IGFkZFB1YmxpY2F0aW9uTGlzdGVuZXIocHVibGljYXRpb24sIGZ1bmN0aW9uIChiYXRjaCkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoc3Vic2NyaXB0aW9uSWQgPT09IGJhdGNoLnN1YnNjcmlwdGlvbklkIHx8ICghc3Vic2NyaXB0aW9uSWQgJiYgY2hlY2tEYXRhU2V0UGFyYW1zSWZNYXRjaGluZ0JhdGNoUGFyYW1zKGJhdGNoLnBhcmFtcykpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWJhdGNoLmRpZmYpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAvLyBDbGVhciB0aGUgY2FjaGUgdG8gcmVidWlsZCBpdCBpZiBhbGwgZGF0YSB3YXMgcmVjZWl2ZWQuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVjb3JkU3RhdGVzID0ge307XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFpc1NpbmdsZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYWNoZS5sZW5ndGggPSAwO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIGFwcGx5Q2hhbmdlcyhiYXRjaC5yZWNvcmRzKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghaXNJbml0aWFsUHVzaENvbXBsZXRlZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlzSW5pdGlhbFB1c2hDb21wbGV0ZWQgPSB0cnVlO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRlZmVycmVkSW5pdGlhbGl6YXRpb24ucmVzb2x2ZShnZXREYXRhKCkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgKiBpZiB0aGUgcGFyYW1zIG9mIHRoZSBkYXRhc2V0IG1hdGNoZXMgdGhlIG5vdGlmaWNhdGlvbiwgaXQgbWVhbnMgdGhlIGRhdGEgbmVlZHMgdG8gYmUgY29sbGVjdCB0byB1cGRhdGUgYXJyYXkuXG4gICAgICAgICAgICAqL1xuICAgICAgICAgICAgZnVuY3Rpb24gY2hlY2tEYXRhU2V0UGFyYW1zSWZNYXRjaGluZ0JhdGNoUGFyYW1zKGJhdGNoUGFyYW1zKSB7XG4gICAgICAgICAgICAgICAgLy8gaWYgKHBhcmFtcy5sZW5ndGggIT0gc3RyZWFtUGFyYW1zLmxlbmd0aCkge1xuICAgICAgICAgICAgICAgIC8vICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICAgICAgLy8gfVxuICAgICAgICAgICAgICAgIGlmICghc3ViUGFyYW1zIHx8IE9iamVjdC5rZXlzKHN1YlBhcmFtcykubGVuZ3RoID09IDApIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRydWVcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgdmFyIG1hdGNoaW5nID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICBmb3IgKHZhciBwYXJhbSBpbiBiYXRjaFBhcmFtcykge1xuICAgICAgICAgICAgICAgICAgICAvLyBhcmUgb3RoZXIgcGFyYW1zIG1hdGNoaW5nP1xuICAgICAgICAgICAgICAgICAgICAvLyBleDogd2UgbWlnaHQgaGF2ZSByZWNlaXZlIGEgbm90aWZpY2F0aW9uIGFib3V0IHRhc2tJZD0yMCBidXQgdGhpcyBzdWJzY3JpcHRpb24gYXJlIG9ubHkgaW50ZXJlc3RlZCBhYm91dCB0YXNrSWQtM1xuICAgICAgICAgICAgICAgICAgICBpZiAoYmF0Y2hQYXJhbXNbcGFyYW1dICE9PSBzdWJQYXJhbXNbcGFyYW1dKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBtYXRjaGluZyA9IGZhbHNlO1xuICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgcmV0dXJuIG1hdGNoaW5nO1xuXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIGZldGNoIGFsbCB0aGUgbWlzc2luZyByZWNvcmRzLCBhbmQgYWN0aXZhdGUgdGhlIGNhbGwgYmFja3MgKGFkZCx1cGRhdGUscmVtb3ZlKSBhY2NvcmRpbmdseSBpZiB0aGVyZSBpcyBzb21ldGhpbmcgdGhhdCBpcyBuZXcgb3Igbm90IGFscmVhZHkgaW4gc3luYy5cbiAgICAgICAgICAgIGZ1bmN0aW9uIGFwcGx5Q2hhbmdlcyhyZWNvcmRzKSB7XG4gICAgICAgICAgICAgICAgdmFyIG5ld0RhdGFBcnJheSA9IFtdO1xuICAgICAgICAgICAgICAgIHZhciBuZXdEYXRhO1xuICAgICAgICAgICAgICAgIHNEcy5yZWFkeSA9IGZhbHNlO1xuICAgICAgICAgICAgICAgIHJlY29yZHMuZm9yRWFjaChmdW5jdGlvbiAocmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vICAgICAgICAgICAgICAgICAgIGxvZ0luZm8oJ0RhdGFzeW5jIFsnICsgZGF0YVN0cmVhbU5hbWUgKyAnXSByZWNlaXZlZDonICtKU09OLnN0cmluZ2lmeShyZWNvcmQpKTsvLysgSlNPTi5zdHJpbmdpZnkocmVjb3JkLmlkKSk7XG4gICAgICAgICAgICAgICAgICAgIGlmIChyZWNvcmQucmVtb3ZlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZW1vdmVSZWNvcmQocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIGlmIChnZXRSZWNvcmRTdGF0ZShyZWNvcmQpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBpZiB0aGUgcmVjb3JkIGlzIGFscmVhZHkgcHJlc2VudCBpbiB0aGUgY2FjaGUuLi5zbyBpdCBpcyBtaWdodGJlIGFuIHVwZGF0ZS4uXG4gICAgICAgICAgICAgICAgICAgICAgICBuZXdEYXRhID0gdXBkYXRlUmVjb3JkKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBuZXdEYXRhID0gYWRkUmVjb3JkKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgaWYgKG5ld0RhdGEpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIG5ld0RhdGFBcnJheS5wdXNoKG5ld0RhdGEpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgc0RzLnJlYWR5ID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICBpZiAoaXNTaW5nbGUpIHtcbiAgICAgICAgICAgICAgICAgICAgc3luY0xpc3RlbmVyLm5vdGlmeSgncmVhZHknLCBnZXREYXRhKCkpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHN5bmNMaXN0ZW5lci5ub3RpZnkoJ3JlYWR5JywgZ2V0RGF0YSgpLCBuZXdEYXRhQXJyYXkpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgKiBBbHRob3VnaCBtb3N0IGNhc2VzIGFyZSBoYW5kbGVkIHVzaW5nIG9uUmVhZHksIHRoaXMgdGVsbHMgeW91IHRoZSBjdXJyZW50IGRhdGEgc3RhdGUuXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICAqIEByZXR1cm5zIGlmIHRydWUgaXMgYSBzeW5jIGhhcyBiZWVuIHByb2Nlc3NlZCBvdGhlcndpc2UgZmFsc2UgaWYgdGhlIGRhdGEgaXMgbm90IHJlYWR5LlxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBpc1JlYWR5KCkge1xuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLnJlYWR5O1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICAqIHJldHVybnMgYSBmdW5jdGlvbiB0byByZW1vdmUgdGhlIGxpc3RlbmVyLlxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBvbkFkZChjYWxsYmFjaykge1xuICAgICAgICAgICAgICAgIHJldHVybiBzeW5jTGlzdGVuZXIub24oJ2FkZCcsIGNhbGxiYWNrKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICAqIHJldHVybnMgYSBmdW5jdGlvbiB0byByZW1vdmUgdGhlIGxpc3RlbmVyLlxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBvblVwZGF0ZShjYWxsYmFjaykge1xuICAgICAgICAgICAgICAgIHJldHVybiBzeW5jTGlzdGVuZXIub24oJ3VwZGF0ZScsIGNhbGxiYWNrKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICAqIHJldHVybnMgYSBmdW5jdGlvbiB0byByZW1vdmUgdGhlIGxpc3RlbmVyLlxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBvblJlbW92ZShjYWxsYmFjaykge1xuICAgICAgICAgICAgICAgIHJldHVybiBzeW5jTGlzdGVuZXIub24oJ3JlbW92ZScsIGNhbGxiYWNrKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICAqIHJldHVybnMgYSBmdW5jdGlvbiB0byByZW1vdmUgdGhlIGxpc3RlbmVyLlxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBvblJlYWR5KGNhbGxiYWNrKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHN5bmNMaXN0ZW5lci5vbigncmVhZHknLCBjYWxsYmFjayk7XG4gICAgICAgICAgICB9XG5cblxuICAgICAgICAgICAgZnVuY3Rpb24gYWRkUmVjb3JkKHJlY29yZCkge1xuICAgICAgICAgICAgICAgIGxvZ0RlYnVnKCdTeW5jIC0+IEluc2VydGVkIE5ldyByZWNvcmQgIycgKyBKU09OLnN0cmluZ2lmeShyZWNvcmQuaWQpICsgJyBmb3Igc3Vic2NyaXB0aW9uIHRvICcgKyBwdWJsaWNhdGlvbik7Ly8gSlNPTi5zdHJpbmdpZnkocmVjb3JkKSk7XG4gICAgICAgICAgICAgICAgZ2V0UmV2aXNpb24ocmVjb3JkKTsgLy8ganVzdCBtYWtlIHN1cmUgd2UgY2FuIGdldCBhIHJldmlzaW9uIGJlZm9yZSB3ZSBoYW5kbGUgdGhpcyByZWNvcmRcbiAgICAgICAgICAgICAgICB1cGRhdGVEYXRhU3RvcmFnZShmb3JtYXRSZWNvcmQgPyBmb3JtYXRSZWNvcmQocmVjb3JkKSA6IHJlY29yZCk7XG4gICAgICAgICAgICAgICAgc3luY0xpc3RlbmVyLm5vdGlmeSgnYWRkJywgcmVjb3JkKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gcmVjb3JkO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiB1cGRhdGVSZWNvcmQocmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgdmFyIHByZXZpb3VzID0gZ2V0UmVjb3JkU3RhdGUocmVjb3JkKTtcbiAgICAgICAgICAgICAgICBpZiAoZ2V0UmV2aXNpb24ocmVjb3JkKSA8PSBnZXRSZXZpc2lvbihwcmV2aW91cykpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGxvZ0RlYnVnKCdTeW5jIC0+IFVwZGF0ZWQgcmVjb3JkICMnICsgSlNPTi5zdHJpbmdpZnkocmVjb3JkLmlkKSArICcgZm9yIHN1YnNjcmlwdGlvbiB0byAnICsgcHVibGljYXRpb24pOy8vIEpTT04uc3RyaW5naWZ5KHJlY29yZCkpO1xuICAgICAgICAgICAgICAgIHVwZGF0ZURhdGFTdG9yYWdlKGZvcm1hdFJlY29yZCA/IGZvcm1hdFJlY29yZChyZWNvcmQpIDogcmVjb3JkKTtcbiAgICAgICAgICAgICAgICBzeW5jTGlzdGVuZXIubm90aWZ5KCd1cGRhdGUnLCByZWNvcmQpO1xuICAgICAgICAgICAgICAgIHJldHVybiByZWNvcmQ7XG4gICAgICAgICAgICB9XG5cblxuICAgICAgICAgICAgZnVuY3Rpb24gcmVtb3ZlUmVjb3JkKHJlY29yZCkge1xuICAgICAgICAgICAgICAgIHZhciBwcmV2aW91cyA9IGdldFJlY29yZFN0YXRlKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgaWYgKCFwcmV2aW91cyB8fCBnZXRSZXZpc2lvbihyZWNvcmQpID4gZ2V0UmV2aXNpb24ocHJldmlvdXMpKSB7XG4gICAgICAgICAgICAgICAgICAgIGxvZ0RlYnVnKCdTeW5jIC0+IFJlbW92ZWQgIycgKyBKU09OLnN0cmluZ2lmeShyZWNvcmQuaWQpICsgJyBmb3Igc3Vic2NyaXB0aW9uIHRvICcgKyBwdWJsaWNhdGlvbik7XG4gICAgICAgICAgICAgICAgICAgIC8vIFdlIGNvdWxkIGhhdmUgZm9yIHRoZSBzYW1lIHJlY29yZCBjb25zZWN1dGl2ZWx5IGZldGNoaW5nIGluIHRoaXMgb3JkZXI6XG4gICAgICAgICAgICAgICAgICAgIC8vIGRlbGV0ZSBpZDo0LCByZXYgMTAsIHRoZW4gYWRkIGlkOjQsIHJldiA5Li4uLiBieSBrZWVwaW5nIHRyYWNrIG9mIHdoYXQgd2FzIGRlbGV0ZWQsIHdlIHdpbGwgbm90IGFkZCB0aGUgcmVjb3JkIHNpbmNlIGl0IHdhcyBkZWxldGVkIHdpdGggYSBtb3N0IHJlY2VudCB0aW1lc3RhbXAuXG4gICAgICAgICAgICAgICAgICAgIHJlY29yZC5yZW1vdmVkID0gdHJ1ZTsgLy8gU28gd2Ugb25seSBmbGFnIGFzIHJlbW92ZWQsIGxhdGVyIG9uIHRoZSBnYXJiYWdlIGNvbGxlY3RvciB3aWxsIGdldCByaWQgb2YgaXQuICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHVwZGF0ZURhdGFTdG9yYWdlKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgIC8vIGlmIHRoZXJlIGlzIG5vIHByZXZpb3VzIHJlY29yZCB3ZSBkbyBub3QgbmVlZCB0byByZW1vdmVkIGFueSB0aGluZyBmcm9tIG91ciBzdG9yYWdlLiAgICAgXG4gICAgICAgICAgICAgICAgICAgIGlmIChwcmV2aW91cykge1xuICAgICAgICAgICAgICAgICAgICAgICAgc3luY0xpc3RlbmVyLm5vdGlmeSgncmVtb3ZlJywgcmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGRpc3Bvc2UocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGZ1bmN0aW9uIGRpc3Bvc2UocmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgJHN5bmNHYXJiYWdlQ29sbGVjdG9yLmRpc3Bvc2UoZnVuY3Rpb24gY29sbGVjdCgpIHtcbiAgICAgICAgICAgICAgICAgICAgdmFyIGV4aXN0aW5nUmVjb3JkID0gZ2V0UmVjb3JkU3RhdGUocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGV4aXN0aW5nUmVjb3JkICYmIHJlY29yZC5yZXZpc2lvbiA+PSBleGlzdGluZ1JlY29yZC5yZXZpc2lvblxuICAgICAgICAgICAgICAgICAgICApIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vbG9nRGVidWcoJ0NvbGxlY3QgTm93OicgKyBKU09OLnN0cmluZ2lmeShyZWNvcmQpKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGRlbGV0ZSByZWNvcmRTdGF0ZXNbZ2V0SWRWYWx1ZShyZWNvcmQuaWQpXTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBpc0V4aXN0aW5nU3RhdGVGb3IocmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuICEhZ2V0UmVjb3JkU3RhdGUocmVjb3JkKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gc2F2ZVJlY29yZFN0YXRlKHJlY29yZCkge1xuICAgICAgICAgICAgICAgIHJlY29yZFN0YXRlc1tnZXRJZFZhbHVlKHJlY29yZC5pZCldID0gcmVjb3JkO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBnZXRSZWNvcmRTdGF0ZShyZWNvcmQpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gcmVjb3JkU3RhdGVzW2dldElkVmFsdWUocmVjb3JkLmlkKV07XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIHVwZGF0ZVN5bmNlZE9iamVjdChyZWNvcmQpIHtcbiAgICAgICAgICAgICAgICBzYXZlUmVjb3JkU3RhdGUocmVjb3JkKTtcblxuICAgICAgICAgICAgICAgIGlmICghcmVjb3JkLnJlbW92ZSkge1xuICAgICAgICAgICAgICAgICAgICAkc3luY01lcmdlLnVwZGF0ZShjYWNoZSwgcmVjb3JkLCBzdHJpY3RNb2RlKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAkc3luY01lcmdlLmNsZWFyT2JqZWN0KGNhY2hlKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIHVwZGF0ZVN5bmNlZEFycmF5KHJlY29yZCkge1xuICAgICAgICAgICAgICAgIHZhciBleGlzdGluZyA9IGdldFJlY29yZFN0YXRlKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgaWYgKCFleGlzdGluZykge1xuICAgICAgICAgICAgICAgICAgICAvLyBhZGQgbmV3IGluc3RhbmNlXG4gICAgICAgICAgICAgICAgICAgIHNhdmVSZWNvcmRTdGF0ZShyZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICBpZiAoIXJlY29yZC5yZW1vdmVkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjYWNoZS5wdXNoKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAkc3luY01lcmdlLnVwZGF0ZShleGlzdGluZywgcmVjb3JkLCBzdHJpY3RNb2RlKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHJlY29yZC5yZW1vdmVkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjYWNoZS5zcGxpY2UoY2FjaGUuaW5kZXhPZihleGlzdGluZyksIDEpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBnZXRSZXZpc2lvbihyZWNvcmQpIHtcbiAgICAgICAgICAgICAgICAvLyB3aGF0IHJlc2VydmVkIGZpZWxkIGRvIHdlIHVzZSBhcyB0aW1lc3RhbXBcbiAgICAgICAgICAgICAgICBpZiAoYW5ndWxhci5pc0RlZmluZWQocmVjb3JkLnJldmlzaW9uKSkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gcmVjb3JkLnJldmlzaW9uO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBpZiAoYW5ndWxhci5pc0RlZmluZWQocmVjb3JkLnRpbWVzdGFtcCkpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHJlY29yZC50aW1lc3RhbXA7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignU3luYyByZXF1aXJlcyBhIHJldmlzaW9uIG9yIHRpbWVzdGFtcCBwcm9wZXJ0eSBpbiByZWNlaXZlZCAnICsgKG9iamVjdENsYXNzID8gJ29iamVjdCBbJyArIG9iamVjdENsYXNzLm5hbWUgKyAnXScgOiAncmVjb3JkJykpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqIHRoaXMgb2JqZWN0IFxuICAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gU3luY0xpc3RlbmVyKCkge1xuICAgICAgICAgICAgdmFyIGV2ZW50cyA9IHt9O1xuICAgICAgICAgICAgdmFyIGNvdW50ID0gMDtcblxuICAgICAgICAgICAgdGhpcy5ub3RpZnkgPSBub3RpZnk7XG4gICAgICAgICAgICB0aGlzLm9uID0gb247XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIG5vdGlmeShldmVudCwgZGF0YTEsIGRhdGEyKSB7XG4gICAgICAgICAgICAgICAgdmFyIGxpc3RlbmVycyA9IGV2ZW50c1tldmVudF07XG4gICAgICAgICAgICAgICAgaWYgKGxpc3RlbmVycykge1xuICAgICAgICAgICAgICAgICAgICBfLmZvckVhY2gobGlzdGVuZXJzLCBmdW5jdGlvbiAoY2FsbGJhY2ssIGlkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjYWxsYmFjayhkYXRhMSwgZGF0YTIpO1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogQHJldHVybnMgaGFuZGxlciB0byB1bnJlZ2lzdGVyIGxpc3RlbmVyXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIG9uKGV2ZW50LCBjYWxsYmFjaykge1xuICAgICAgICAgICAgICAgIHZhciBsaXN0ZW5lcnMgPSBldmVudHNbZXZlbnRdO1xuICAgICAgICAgICAgICAgIGlmICghbGlzdGVuZXJzKSB7XG4gICAgICAgICAgICAgICAgICAgIGxpc3RlbmVycyA9IGV2ZW50c1tldmVudF0gPSB7fTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgdmFyIGlkID0gY291bnQrKztcbiAgICAgICAgICAgICAgICBsaXN0ZW5lcnNbaWQrK10gPSBjYWxsYmFjaztcbiAgICAgICAgICAgICAgICByZXR1cm4gZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgICAgICBkZWxldGUgbGlzdGVuZXJzW2lkXTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9O1xuICAgIGZ1bmN0aW9uIGdldElkVmFsdWUoaWQpIHtcbiAgICAgICAgaWYgKCFfLmlzT2JqZWN0KGlkKSkge1xuICAgICAgICAgICAgcmV0dXJuIGlkO1xuICAgICAgICB9XG4gICAgICAgIC8vIGJ1aWxkIGNvbXBvc2l0ZSBrZXkgdmFsdWVcbiAgICAgICAgdmFyIHIgPSBfLmpvaW4oXy5tYXAoaWQsIGZ1bmN0aW9uICh2YWx1ZSkge1xuICAgICAgICAgICAgcmV0dXJuIHZhbHVlO1xuICAgICAgICB9KSwgJ34nKTtcbiAgICAgICAgcmV0dXJuIHI7XG4gICAgfVxuXG5cbiAgICBmdW5jdGlvbiBsb2dJbmZvKG1zZykge1xuICAgICAgICBpZiAoZGVidWcpIHtcbiAgICAgICAgICAgIGNvbnNvbGUuZGVidWcoJ1NZTkMoaW5mbyk6ICcgKyBtc2cpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gbG9nRGVidWcobXNnKSB7XG4gICAgICAgIGlmIChkZWJ1ZyA9PSAyKSB7XG4gICAgICAgICAgICBjb25zb2xlLmRlYnVnKCdTWU5DKGRlYnVnKTogJyArIG1zZyk7XG4gICAgICAgIH1cblxuICAgIH1cblxuXG5cbn07XG5cbiJdfQ==
