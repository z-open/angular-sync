(function() {
"use strict";

angular
    .module('sync', ['socketio-auth'])
    .config(["$socketioProvider", function($socketioProvider){
        $socketioProvider.setDebug(true);
    }]);
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
            if (!isStrictMode) {
                array.push(item);
            } else {
                // QUICK FIX: I had to remove this code.... since survey does not work...
                //
                // object in array must have an id otherwise we can't maintain the instance reference
                if (!_.isArray(item) && _.isObject(item)) {
                    // let try to find the instance
                    if (angular.isDefined(item.id)) {
                        array.push(mergeObject(_.find(destination, { id: item.id }), item, isStrictMode));
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
        var SYNC_VERSION = '1.1';


        listenToSyncNotification();

        var service = {
            subscribe: subscribe,
            resolveSubscription: resolveSubscription,
            getGracePeriod: getGracePeriod
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
                strictMode = true;
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
                    //                   logInfo('Datasync [' + dataStreamName + '] received:' +JSON.stringify(record));//+ record.id);
                    if (record.remove) {
                        removeRecord(record);
                    } else if (recordStates[record.id]) {
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
                logDebug('Sync -> Inserted New record #' + record.id + ' for subscription to ' + publication);// JSON.stringify(record));
                getRevision(record); // just make sure we can get a revision before we handle this record
                updateDataStorage(formatRecord ? formatRecord(record) : record);
                syncListener.notify('add', record);
                return record;
            }

            function updateRecord(record) {
                var previous = recordStates[record.id];
                if (getRevision(record) <= getRevision(previous)) {
                    return null;
                }
                logDebug('Sync -> Updated record #' + record.id + ' for subscription to ' + publication);// JSON.stringify(record));
                updateDataStorage(formatRecord ? formatRecord(record) : record);
                syncListener.notify('update', record);
                return record;
            }


            function removeRecord(record) {
                var previous = recordStates[record.id];
                if (!previous || getRevision(record) > getRevision(previous)) {
                    logDebug('Sync -> Removed #' + record.id + ' for subscription to ' + publication);
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
                    var existingRecord = recordStates[record.id];
                    if (existingRecord && record.revision >= existingRecord.revision
                    ) {
                        //logDebug('Collect Now:' + JSON.stringify(record));
                        delete recordStates[record.id];
                    }
                });
            }

            function isExistingStateFor(recordId) {
                return !!recordStates[recordId];
            }

            function updateSyncedObject(record) {
                recordStates[record.id] = record;

                if (!record.remove) {
                    $syncMerge.merge(cache, record, strictMode);
                } else {
                    $syncMerge.clearObject(cache);
                }
            }

            function updateSyncedArray(record) {
                var existing = recordStates[record.id];
                if (!existing) {
                    // add new instance
                    recordStates[record.id] = record;
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


//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImFuZ3VsYXItc3luYy5qcyIsInN5bmMubW9kdWxlLmpzIiwic2VydmljZXMvc3luYy1nYXJiYWdlLWNvbGxlY3Rvci5zZXJ2aWNlLmpzIiwic2VydmljZXMvc3luYy1tZXJnZS5zZXJ2aWNlLmpzIiwic2VydmljZXMvc3luYy5zZXJ2aWNlLmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLENBQUMsV0FBVztBQUNaOztBQ0RBO0tBQ0EsT0FBQSxRQUFBLENBQUE7S0FDQSw2QkFBQSxTQUFBLGtCQUFBO1FBQ0Esa0JBQUEsU0FBQTs7OztBRE9BLENBQUMsV0FBVztBQUNaOztBRVhBO0tBQ0EsT0FBQTtLQUNBLFFBQUEseUJBQUE7Ozs7Ozs7Ozs7QUFVQSxTQUFBLHVCQUFBO0lBQ0EsSUFBQSxRQUFBO0lBQ0EsSUFBQSxVQUFBO0lBQ0EsSUFBQSxZQUFBOztJQUVBLElBQUEsVUFBQTtRQUNBLFlBQUE7UUFDQSxZQUFBO1FBQ0EsU0FBQTtRQUNBLFVBQUE7UUFDQSxLQUFBO1FBQ0EsY0FBQTs7O0lBR0EsT0FBQTs7OztJQUlBLFNBQUEsV0FBQSxPQUFBO1FBQ0EsVUFBQTs7O0lBR0EsU0FBQSxhQUFBO1FBQ0EsT0FBQTs7O0lBR0EsU0FBQSxlQUFBO1FBQ0EsT0FBQSxNQUFBOzs7SUFHQSxTQUFBLFFBQUEsU0FBQTtRQUNBLE1BQUEsS0FBQTtZQUNBLFdBQUEsS0FBQTtZQUNBLFNBQUE7O1FBRUEsSUFBQSxDQUFBLFdBQUE7WUFDQSxRQUFBOzs7O0lBSUEsU0FBQSxXQUFBO1FBQ0EsSUFBQSxDQUFBLFNBQUE7WUFDQSxRQUFBO1lBQ0E7O1FBRUEsWUFBQTtRQUNBLFdBQUEsWUFBQTtZQUNBLFFBQUE7WUFDQSxJQUFBLE1BQUEsU0FBQSxHQUFBO2dCQUNBO21CQUNBO2dCQUNBLFlBQUE7O1dBRUEsVUFBQTs7O0lBR0EsU0FBQSxNQUFBO1FBQ0EsSUFBQSxVQUFBLEtBQUEsUUFBQSxVQUFBO1FBQ0EsT0FBQSxNQUFBLFNBQUEsS0FBQSxNQUFBLEdBQUEsYUFBQSxTQUFBO1lBQ0EsTUFBQSxRQUFBOzs7Ozs7QUZtQkEsQ0FBQyxXQUFXO0FBQ1o7O0FHMUZBO0tBQ0EsT0FBQTtLQUNBLFFBQUEsY0FBQTs7QUFFQSxTQUFBLFlBQUE7O0lBRUEsT0FBQTtRQUNBLE9BQUE7UUFDQSxhQUFBOzs7Ozs7Ozs7Ozs7SUFZQSxTQUFBLFlBQUEsYUFBQSxRQUFBLGNBQUE7UUFDQSxJQUFBLENBQUEsYUFBQTtZQUNBLE9BQUE7OztRQUdBLElBQUEsU0FBQTtRQUNBLEtBQUEsSUFBQSxZQUFBLFFBQUE7WUFDQSxJQUFBLEVBQUEsUUFBQSxPQUFBLFlBQUE7Z0JBQ0EsT0FBQSxZQUFBLFdBQUEsWUFBQSxXQUFBLE9BQUEsV0FBQTttQkFDQSxJQUFBLEVBQUEsV0FBQSxPQUFBLFlBQUE7Z0JBQ0EsT0FBQSxZQUFBLE9BQUE7bUJBQ0EsSUFBQSxFQUFBLFNBQUEsT0FBQSxZQUFBO2dCQUNBLE9BQUEsWUFBQSxZQUFBLFlBQUEsV0FBQSxPQUFBLFdBQUE7bUJBQ0E7Z0JBQ0EsT0FBQSxZQUFBLE9BQUE7Ozs7UUFJQSxZQUFBO1FBQ0EsRUFBQSxPQUFBLGFBQUE7O1FBRUEsT0FBQTs7O0lBR0EsU0FBQSxXQUFBLGFBQUEsUUFBQSxjQUFBO1FBQ0EsSUFBQSxDQUFBLGFBQUE7WUFDQSxPQUFBOztRQUVBLElBQUEsUUFBQTtRQUNBLE9BQUEsUUFBQSxVQUFBLE1BQUE7WUFDQSxJQUFBLENBQUEsY0FBQTtnQkFDQSxNQUFBLEtBQUE7bUJBQ0E7Ozs7Z0JBSUEsSUFBQSxDQUFBLEVBQUEsUUFBQSxTQUFBLEVBQUEsU0FBQSxPQUFBOztvQkFFQSxJQUFBLFFBQUEsVUFBQSxLQUFBLEtBQUE7d0JBQ0EsTUFBQSxLQUFBLFlBQUEsRUFBQSxLQUFBLGFBQUEsRUFBQSxJQUFBLEtBQUEsT0FBQSxNQUFBOzJCQUNBO3dCQUNBLElBQUEsY0FBQTs0QkFDQSxNQUFBLElBQUEsTUFBQSwyRkFBQSxLQUFBLFVBQUE7O3dCQUVBLE1BQUEsS0FBQTs7dUJBRUE7b0JBQ0EsTUFBQSxLQUFBOzs7OztRQUtBLFlBQUEsU0FBQTtRQUNBLE1BQUEsVUFBQSxLQUFBLE1BQUEsYUFBQTs7UUFFQSxPQUFBOzs7SUFHQSxTQUFBLFlBQUEsUUFBQTtRQUNBLE9BQUEsS0FBQSxRQUFBLFFBQUEsVUFBQSxLQUFBLEVBQUEsT0FBQSxPQUFBOztDQUVBOzs7QUgrRkEsQ0FBQyxXQUFXO0FBQ1o7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O0FJNUpBO0tBQ0EsT0FBQTtLQUNBLFNBQUEsU0FBQTs7QUFFQSxTQUFBLGVBQUE7O0lBRUEsSUFBQTs7SUFFQSxLQUFBLFdBQUEsVUFBQSxPQUFBO1FBQ0EsUUFBQTs7O0lBR0EsS0FBQSxnRkFBQSxTQUFBLEtBQUEsWUFBQSxJQUFBLFdBQUEsdUJBQUEsWUFBQTs7UUFFQSxJQUFBLHVCQUFBO1lBQ0EsMkJBQUE7UUFDQSxJQUFBLDBCQUFBO1FBQ0EsSUFBQSxlQUFBOzs7UUFHQTs7UUFFQSxJQUFBLFVBQUE7WUFDQSxXQUFBO1lBQ0EscUJBQUE7WUFDQSxnQkFBQTs7O1FBR0EsT0FBQTs7Ozs7Ozs7Ozs7OztRQWFBLFNBQUEsb0JBQUEsaUJBQUEsUUFBQSxhQUFBO1lBQ0EsSUFBQSxXQUFBLEdBQUE7WUFDQSxJQUFBLE1BQUEsVUFBQSxpQkFBQSxlQUFBOzs7WUFHQSxJQUFBLGNBQUEsV0FBQSxZQUFBO2dCQUNBLElBQUEsQ0FBQSxJQUFBLE9BQUE7b0JBQ0EsSUFBQTtvQkFDQSxRQUFBLHlDQUFBLGtCQUFBO29CQUNBLFNBQUEsT0FBQTs7ZUFFQSwwQkFBQTs7WUFFQSxJQUFBLGNBQUE7aUJBQ0E7aUJBQ0EsS0FBQSxZQUFBO29CQUNBLGFBQUE7b0JBQ0EsU0FBQSxRQUFBO21CQUNBLE1BQUEsWUFBQTtvQkFDQSxhQUFBO29CQUNBLElBQUE7b0JBQ0EsU0FBQSxPQUFBLHdDQUFBLGtCQUFBOztZQUVBLE9BQUEsU0FBQTs7Ozs7OztRQU9BLFNBQUEsaUJBQUE7WUFDQSxPQUFBOzs7Ozs7Ozs7O1FBVUEsU0FBQSxVQUFBLGlCQUFBLE9BQUE7WUFDQSxPQUFBLElBQUEsYUFBQSxpQkFBQTs7Ozs7Ozs7O1FBU0EsU0FBQSwyQkFBQTtZQUNBLFVBQUEsR0FBQSxZQUFBLFVBQUEsaUJBQUEsSUFBQTtnQkFDQSxRQUFBLHFDQUFBLGdCQUFBLE9BQUEsVUFBQSxnQkFBQSxpQkFBQSxlQUFBLEtBQUEsVUFBQSxnQkFBQSxVQUFBLGdCQUFBLGdCQUFBLFFBQUEsU0FBQSxPQUFBLGdCQUFBLE9BQUEsU0FBQSxTQUFBO2dCQUNBLElBQUEsWUFBQSxxQkFBQSxnQkFBQTtnQkFDQSxJQUFBLFdBQUE7b0JBQ0EsS0FBQSxJQUFBLFlBQUEsV0FBQTt3QkFDQSxVQUFBLFVBQUE7OztnQkFHQSxHQUFBOztTQUVBOzs7O1FBSUEsU0FBQSx1QkFBQSxZQUFBLFVBQUE7WUFDQSxJQUFBLE1BQUE7WUFDQSxJQUFBLFlBQUEscUJBQUE7WUFDQSxJQUFBLENBQUEsV0FBQTtnQkFDQSxxQkFBQSxjQUFBLFlBQUE7O1lBRUEsVUFBQSxPQUFBOztZQUVBLE9BQUEsWUFBQTtnQkFDQSxPQUFBLFVBQUE7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7O1FBMEJBLFNBQUEsYUFBQSxhQUFBLE9BQUE7WUFDQSxJQUFBLGdCQUFBLGNBQUEsT0FBQSxVQUFBLG1CQUFBLE9BQUEsd0JBQUEsd0JBQUE7WUFDQSxJQUFBLFlBQUE7WUFDQSxJQUFBLGNBQUEsd0JBQUE7WUFDQSxJQUFBO1lBQ0EsSUFBQTs7WUFFQSxJQUFBLE1BQUE7WUFDQSxJQUFBLFlBQUE7WUFDQSxJQUFBLGVBQUE7WUFDQSxJQUFBO1lBQ0EsSUFBQSxlQUFBLElBQUE7OztZQUdBLEtBQUEsUUFBQTtZQUNBLEtBQUEsU0FBQTtZQUNBLEtBQUEsVUFBQTtZQUNBLEtBQUEsYUFBQTs7WUFFQSxLQUFBLFVBQUE7WUFDQSxLQUFBLFdBQUE7WUFDQSxLQUFBLFFBQUE7WUFDQSxLQUFBLFdBQUE7O1lBRUEsS0FBQSxVQUFBO1lBQ0EsS0FBQSxnQkFBQTs7WUFFQSxLQUFBLG1CQUFBO1lBQ0EsS0FBQSwyQkFBQTs7WUFFQSxLQUFBLFdBQUE7WUFDQSxLQUFBLFlBQUE7WUFDQSxLQUFBLFVBQUE7O1lBRUEsS0FBQSxZQUFBOztZQUVBLEtBQUEsaUJBQUE7WUFDQSxLQUFBLGlCQUFBOztZQUVBLEtBQUEsZ0JBQUE7O1lBRUEsS0FBQSxTQUFBO1lBQ0EsS0FBQSxVQUFBOztZQUVBLEtBQUEscUJBQUE7O1lBRUEsVUFBQTs7O1lBR0EsT0FBQSxTQUFBOzs7O1lBSUEsU0FBQSxVQUFBO2dCQUNBOzs7Ozs7OztZQVFBLFNBQUEsV0FBQSxVQUFBO2dCQUNBLElBQUEsWUFBQTtvQkFDQTs7Z0JBRUEsYUFBQSxRQUFBO2dCQUNBLE9BQUE7Ozs7Ozs7OztZQVNBLFNBQUEsU0FBQSxPQUFBO2dCQUNBLElBQUEsT0FBQTs7b0JBRUEsSUFBQTs7Z0JBRUEsT0FBQTs7Ozs7Ozs7Ozs7O1lBWUEsU0FBQSxjQUFBLE9BQUE7Z0JBQ0EsYUFBQTs7Ozs7Ozs7OztZQVVBLFNBQUEsZUFBQSxZQUFBO2dCQUNBLElBQUEsd0JBQUE7b0JBQ0EsT0FBQTs7O2dCQUdBLGNBQUE7Z0JBQ0EsZUFBQSxVQUFBLFFBQUE7b0JBQ0EsT0FBQSxJQUFBLFlBQUE7O2dCQUVBLFVBQUE7Z0JBQ0EsT0FBQTs7O1lBR0EsU0FBQSxpQkFBQTtnQkFDQSxPQUFBOzs7Ozs7Ozs7Ozs7OztZQWNBLFNBQUEsY0FBQSxnQkFBQSxTQUFBO2dCQUNBLElBQUEsZUFBQSxRQUFBLE9BQUEsZ0JBQUEsWUFBQTs7b0JBRUEsT0FBQTs7Z0JBRUE7Z0JBQ0EsSUFBQSxDQUFBLFVBQUE7b0JBQ0EsTUFBQSxTQUFBOzs7Z0JBR0EsWUFBQSxrQkFBQTtnQkFDQSxVQUFBLFdBQUE7Z0JBQ0EsSUFBQSxRQUFBLFVBQUEsUUFBQSxTQUFBO29CQUNBLFVBQUEsUUFBQTs7Z0JBRUE7Z0JBQ0EsT0FBQTs7OztZQUlBLFNBQUEsMkJBQUE7Z0JBQ0EsT0FBQSx1QkFBQSxRQUFBLEtBQUEsWUFBQTtvQkFDQSxPQUFBOzs7OztZQUtBLFNBQUEsbUJBQUE7Z0JBQ0EsT0FBQSx1QkFBQTs7OztZQUlBLFNBQUEsVUFBQSxPQUFBO2dCQUNBLElBQUEsd0JBQUE7b0JBQ0EsT0FBQTs7O2dCQUdBLElBQUE7Z0JBQ0EsV0FBQTtnQkFDQSxJQUFBLE9BQUE7b0JBQ0EsV0FBQTtvQkFDQSxRQUFBLGNBQUEsSUFBQSxZQUFBLE1BQUE7dUJBQ0E7b0JBQ0EsV0FBQTtvQkFDQSxRQUFBOzs7Z0JBR0Esb0JBQUEsVUFBQSxRQUFBO29CQUNBLElBQUE7d0JBQ0EsU0FBQTtzQkFDQSxPQUFBLEdBQUE7d0JBQ0EsRUFBQSxVQUFBLCtDQUFBLGNBQUEsUUFBQSxLQUFBLFVBQUEsVUFBQSxnQkFBQSxFQUFBO3dCQUNBLE1BQUE7Ozs7Z0JBSUEsT0FBQTs7OztZQUlBLFNBQUEsVUFBQTtnQkFDQSxPQUFBOzs7Ozs7Ozs7O1lBVUEsU0FBQSxTQUFBO2dCQUNBLElBQUEsYUFBQTtvQkFDQSxPQUFBLHVCQUFBOztnQkFFQSx5QkFBQSxHQUFBO2dCQUNBLHlCQUFBO2dCQUNBLFFBQUEsVUFBQSxjQUFBLGlCQUFBLEtBQUEsVUFBQTtnQkFDQSxjQUFBO2dCQUNBO2dCQUNBO2dCQUNBLE9BQUEsdUJBQUE7Ozs7OztZQU1BLFNBQUEsVUFBQTtnQkFDQSxJQUFBLHdCQUFBOztvQkFFQSx1QkFBQSxRQUFBOztnQkFFQSxJQUFBLGFBQUE7b0JBQ0E7b0JBQ0EsY0FBQTs7b0JBRUEsUUFBQSxVQUFBLGNBQUEsa0JBQUEsS0FBQSxVQUFBO29CQUNBLElBQUEsd0JBQUE7d0JBQ0E7d0JBQ0EseUJBQUE7O29CQUVBLElBQUEsY0FBQTt3QkFDQTt3QkFDQSxlQUFBOzs7OztZQUtBLFNBQUEsWUFBQTtnQkFDQSxPQUFBOzs7WUFHQSxTQUFBLG9CQUFBO2dCQUNBLElBQUEsQ0FBQSx3QkFBQTtvQkFDQTtvQkFDQTs7Ozs7Ozs7O1lBU0EsU0FBQSxPQUFBLFVBQUE7Z0JBQ0EsSUFBQSx3QkFBQTtvQkFDQSxPQUFBOztnQkFFQSxJQUFBLFlBQUE7b0JBQ0E7O2dCQUVBLGFBQUE7Z0JBQ0EsYUFBQSxXQUFBLElBQUEsWUFBQTs7Z0JBRUEsT0FBQTs7O1lBR0EsU0FBQSw4QkFBQSxXQUFBOztnQkFFQSxXQUFBLFlBQUE7b0JBQ0EsZUFBQSxXQUFBLElBQUEsa0JBQUEsWUFBQTt3QkFDQSxTQUFBLHFDQUFBOzt3QkFFQTs7bUJBRUEsWUFBQSxJQUFBOzs7WUFHQSxTQUFBLHVCQUFBO2dCQUNBLFVBQUEsTUFBQSxrQkFBQTtvQkFDQSxTQUFBO29CQUNBLElBQUE7b0JBQ0EsYUFBQTtvQkFDQSxRQUFBO21CQUNBLEtBQUEsVUFBQSxPQUFBO29CQUNBLGlCQUFBOzs7O1lBSUEsU0FBQSx5QkFBQTtnQkFDQSxJQUFBLGdCQUFBO29CQUNBLFVBQUEsTUFBQSxvQkFBQTt3QkFDQSxTQUFBO3dCQUNBLElBQUE7O29CQUVBLGlCQUFBOzs7O1lBSUEsU0FBQSxzQkFBQTs7Z0JBRUEseUJBQUEsdUJBQUEsYUFBQSxVQUFBLE9BQUE7b0JBQ0EsSUFBQSxtQkFBQSxNQUFBLG1CQUFBLENBQUEsa0JBQUEsd0NBQUEsTUFBQSxVQUFBO3dCQUNBLElBQUEsQ0FBQSxNQUFBLE1BQUE7OzRCQUVBLGVBQUE7NEJBQ0EsSUFBQSxDQUFBLFVBQUE7Z0NBQ0EsTUFBQSxTQUFBOzs7d0JBR0EsYUFBQSxNQUFBO3dCQUNBLElBQUEsQ0FBQSx3QkFBQTs0QkFDQSx5QkFBQTs0QkFDQSx1QkFBQSxRQUFBOzs7Ozs7Ozs7WUFTQSxTQUFBLHdDQUFBLGFBQUE7Ozs7Z0JBSUEsSUFBQSxDQUFBLGFBQUEsT0FBQSxLQUFBLFdBQUEsVUFBQSxHQUFBO29CQUNBLE9BQUE7O2dCQUVBLElBQUEsV0FBQTtnQkFDQSxLQUFBLElBQUEsU0FBQSxhQUFBOzs7b0JBR0EsSUFBQSxZQUFBLFdBQUEsVUFBQSxRQUFBO3dCQUNBLFdBQUE7d0JBQ0E7OztnQkFHQSxPQUFBOzs7OztZQUtBLFNBQUEsYUFBQSxTQUFBO2dCQUNBLElBQUEsZUFBQTtnQkFDQSxJQUFBO2dCQUNBLElBQUEsUUFBQTtnQkFDQSxRQUFBLFFBQUEsVUFBQSxRQUFBOztvQkFFQSxJQUFBLE9BQUEsUUFBQTt3QkFDQSxhQUFBOzJCQUNBLElBQUEsYUFBQSxPQUFBLEtBQUE7O3dCQUVBLFVBQUEsYUFBQTsyQkFDQTt3QkFDQSxVQUFBLFVBQUE7O29CQUVBLElBQUEsU0FBQTt3QkFDQSxhQUFBLEtBQUE7OztnQkFHQSxJQUFBLFFBQUE7Z0JBQ0EsSUFBQSxVQUFBO29CQUNBLGFBQUEsT0FBQSxTQUFBO3VCQUNBO29CQUNBLGFBQUEsT0FBQSxTQUFBLFdBQUE7Ozs7Ozs7OztZQVNBLFNBQUEsVUFBQTtnQkFDQSxPQUFBLEtBQUE7Ozs7OztZQU1BLFNBQUEsTUFBQSxVQUFBO2dCQUNBLE9BQUEsYUFBQSxHQUFBLE9BQUE7Ozs7Ozs7WUFPQSxTQUFBLFNBQUEsVUFBQTtnQkFDQSxPQUFBLGFBQUEsR0FBQSxVQUFBOzs7Ozs7O1lBT0EsU0FBQSxTQUFBLFVBQUE7Z0JBQ0EsT0FBQSxhQUFBLEdBQUEsVUFBQTs7Ozs7OztZQU9BLFNBQUEsUUFBQSxVQUFBO2dCQUNBLE9BQUEsYUFBQSxHQUFBLFNBQUE7Ozs7WUFJQSxTQUFBLFVBQUEsUUFBQTtnQkFDQSxTQUFBLGtDQUFBLE9BQUEsS0FBQSwwQkFBQTtnQkFDQSxZQUFBO2dCQUNBLGtCQUFBLGVBQUEsYUFBQSxVQUFBO2dCQUNBLGFBQUEsT0FBQSxPQUFBO2dCQUNBLE9BQUE7OztZQUdBLFNBQUEsYUFBQSxRQUFBO2dCQUNBLElBQUEsV0FBQSxhQUFBLE9BQUE7Z0JBQ0EsSUFBQSxZQUFBLFdBQUEsWUFBQSxXQUFBO29CQUNBLE9BQUE7O2dCQUVBLFNBQUEsNkJBQUEsT0FBQSxLQUFBLDBCQUFBO2dCQUNBLGtCQUFBLGVBQUEsYUFBQSxVQUFBO2dCQUNBLGFBQUEsT0FBQSxVQUFBO2dCQUNBLE9BQUE7Ozs7WUFJQSxTQUFBLGFBQUEsUUFBQTtnQkFDQSxJQUFBLFdBQUEsYUFBQSxPQUFBO2dCQUNBLElBQUEsQ0FBQSxZQUFBLFlBQUEsVUFBQSxZQUFBLFdBQUE7b0JBQ0EsU0FBQSxzQkFBQSxPQUFBLEtBQUEsMEJBQUE7OztvQkFHQSxPQUFBLFVBQUE7b0JBQ0Esa0JBQUE7O29CQUVBLElBQUEsVUFBQTt3QkFDQSxhQUFBLE9BQUEsVUFBQTt3QkFDQSxRQUFBOzs7O1lBSUEsU0FBQSxRQUFBLFFBQUE7Z0JBQ0Esc0JBQUEsUUFBQSxTQUFBLFVBQUE7b0JBQ0EsSUFBQSxpQkFBQSxhQUFBLE9BQUE7b0JBQ0EsSUFBQSxrQkFBQSxPQUFBLFlBQUEsZUFBQTtzQkFDQTs7d0JBRUEsT0FBQSxhQUFBLE9BQUE7Ozs7O1lBS0EsU0FBQSxtQkFBQSxVQUFBO2dCQUNBLE9BQUEsQ0FBQSxDQUFBLGFBQUE7OztZQUdBLFNBQUEsbUJBQUEsUUFBQTtnQkFDQSxhQUFBLE9BQUEsTUFBQTs7Z0JBRUEsSUFBQSxDQUFBLE9BQUEsUUFBQTtvQkFDQSxXQUFBLE1BQUEsT0FBQSxRQUFBO3VCQUNBO29CQUNBLFdBQUEsWUFBQTs7OztZQUlBLFNBQUEsa0JBQUEsUUFBQTtnQkFDQSxJQUFBLFdBQUEsYUFBQSxPQUFBO2dCQUNBLElBQUEsQ0FBQSxVQUFBOztvQkFFQSxhQUFBLE9BQUEsTUFBQTtvQkFDQSxJQUFBLENBQUEsT0FBQSxTQUFBO3dCQUNBLE1BQUEsS0FBQTs7dUJBRUE7b0JBQ0EsV0FBQSxNQUFBLFVBQUEsUUFBQTtvQkFDQSxJQUFBLE9BQUEsU0FBQTt3QkFDQSxNQUFBLE9BQUEsTUFBQSxRQUFBLFdBQUE7Ozs7Ozs7OztZQVNBLFNBQUEsWUFBQSxRQUFBOztnQkFFQSxJQUFBLFFBQUEsVUFBQSxPQUFBLFdBQUE7b0JBQ0EsT0FBQSxPQUFBOztnQkFFQSxJQUFBLFFBQUEsVUFBQSxPQUFBLFlBQUE7b0JBQ0EsT0FBQSxPQUFBOztnQkFFQSxNQUFBLElBQUEsTUFBQSxpRUFBQSxjQUFBLGFBQUEsWUFBQSxPQUFBLE1BQUE7Ozs7Ozs7UUFPQSxTQUFBLGVBQUE7WUFDQSxJQUFBLFNBQUE7WUFDQSxJQUFBLFFBQUE7O1lBRUEsS0FBQSxTQUFBO1lBQ0EsS0FBQSxLQUFBOztZQUVBLFNBQUEsT0FBQSxPQUFBLE9BQUEsT0FBQTtnQkFDQSxJQUFBLFlBQUEsT0FBQTtnQkFDQSxJQUFBLFdBQUE7b0JBQ0EsRUFBQSxRQUFBLFdBQUEsVUFBQSxVQUFBLElBQUE7d0JBQ0EsU0FBQSxPQUFBOzs7Ozs7OztZQVFBLFNBQUEsR0FBQSxPQUFBLFVBQUE7Z0JBQ0EsSUFBQSxZQUFBLE9BQUE7Z0JBQ0EsSUFBQSxDQUFBLFdBQUE7b0JBQ0EsWUFBQSxPQUFBLFNBQUE7O2dCQUVBLElBQUEsS0FBQTtnQkFDQSxVQUFBLFFBQUE7Z0JBQ0EsT0FBQSxZQUFBO29CQUNBLE9BQUEsVUFBQTs7Ozs7O0lBTUEsU0FBQSxRQUFBLEtBQUE7UUFDQSxJQUFBLE9BQUE7WUFDQSxRQUFBLE1BQUEsaUJBQUE7Ozs7SUFJQSxTQUFBLFNBQUEsS0FBQTtRQUNBLElBQUEsU0FBQSxHQUFBO1lBQ0EsUUFBQSxNQUFBLGtCQUFBOzs7Ozs7O0NBT0E7OztBSnNMQSIsImZpbGUiOiJhbmd1bGFyLXN5bmMuanMiLCJzb3VyY2VzQ29udGVudCI6WyIoZnVuY3Rpb24oKSB7XG5cInVzZSBzdHJpY3RcIjtcblxuYW5ndWxhclxuICAgIC5tb2R1bGUoJ3N5bmMnLCBbJ3NvY2tldGlvLWF1dGgnXSlcbiAgICAuY29uZmlnKGZ1bmN0aW9uKCRzb2NrZXRpb1Byb3ZpZGVyKXtcbiAgICAgICAgJHNvY2tldGlvUHJvdmlkZXIuc2V0RGVidWcodHJ1ZSk7XG4gICAgfSk7XG59KCkpO1xuXG4oZnVuY3Rpb24oKSB7XG5cInVzZSBzdHJpY3RcIjtcblxuYW5ndWxhclxuICAgIC5tb2R1bGUoJ3N5bmMnKVxuICAgIC5mYWN0b3J5KCckc3luY0dhcmJhZ2VDb2xsZWN0b3InLCBzeW5jR2FyYmFnZUNvbGxlY3Rvcik7XG5cbi8qKlxuICogc2FmZWx5IHJlbW92ZSBkZWxldGVkIHJlY29yZC9vYmplY3QgZnJvbSBtZW1vcnkgYWZ0ZXIgdGhlIHN5bmMgcHJvY2VzcyBkaXNwb3NlZCB0aGVtLlxuICogXG4gKiBUT0RPOiBTZWNvbmRzIHNob3VsZCByZWZsZWN0IHRoZSBtYXggdGltZSAgdGhhdCBzeW5jIGNhY2hlIGlzIHZhbGlkIChuZXR3b3JrIGxvc3Mgd291bGQgZm9yY2UgYSByZXN5bmMpLCB3aGljaCBzaG91bGQgbWF0Y2ggbWF4RGlzY29ubmVjdGlvblRpbWVCZWZvcmVEcm9wcGluZ1N1YnNjcmlwdGlvbiBvbiB0aGUgc2VydmVyIHNpZGUuXG4gKiBcbiAqIE5vdGU6XG4gKiByZW1vdmVkIHJlY29yZCBzaG91bGQgYmUgZGVsZXRlZCBmcm9tIHRoZSBzeW5jIGludGVybmFsIGNhY2hlIGFmdGVyIGEgd2hpbGUgc28gdGhhdCB0aGV5IGRvIG5vdCBzdGF5IGluIHRoZSBtZW1vcnkuIFRoZXkgY2Fubm90IGJlIHJlbW92ZWQgdG9vIGVhcmx5IGFzIGFuIG9sZGVyIHZlcnNpb24vc3RhbXAgb2YgdGhlIHJlY29yZCBjb3VsZCBiZSByZWNlaXZlZCBhZnRlciBpdHMgcmVtb3ZhbC4uLndoaWNoIHdvdWxkIHJlLWFkZCB0byBjYWNoZS4uLmR1ZSBhc3luY2hyb25vdXMgcHJvY2Vzc2luZy4uLlxuICovXG5mdW5jdGlvbiBzeW5jR2FyYmFnZUNvbGxlY3RvcigpIHtcbiAgICB2YXIgaXRlbXMgPSBbXTtcbiAgICB2YXIgc2Vjb25kcyA9IDI7XG4gICAgdmFyIHNjaGVkdWxlZCA9IGZhbHNlO1xuXG4gICAgdmFyIHNlcnZpY2UgPSB7XG4gICAgICAgIHNldFNlY29uZHM6IHNldFNlY29uZHMsXG4gICAgICAgIGdldFNlY29uZHM6IGdldFNlY29uZHMsXG4gICAgICAgIGRpc3Bvc2U6IGRpc3Bvc2UsXG4gICAgICAgIHNjaGVkdWxlOiBzY2hlZHVsZSxcbiAgICAgICAgcnVuOiBydW4sXG4gICAgICAgIGdldEl0ZW1Db3VudDogZ2V0SXRlbUNvdW50XG4gICAgfTtcblxuICAgIHJldHVybiBzZXJ2aWNlO1xuXG4gICAgLy8vLy8vLy8vL1xuXG4gICAgZnVuY3Rpb24gc2V0U2Vjb25kcyh2YWx1ZSkge1xuICAgICAgICBzZWNvbmRzID0gdmFsdWU7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gZ2V0U2Vjb25kcygpIHtcbiAgICAgICAgcmV0dXJuIHNlY29uZHM7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gZ2V0SXRlbUNvdW50KCkge1xuICAgICAgICByZXR1cm4gaXRlbXMubGVuZ3RoO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIGRpc3Bvc2UoY29sbGVjdCkge1xuICAgICAgICBpdGVtcy5wdXNoKHtcbiAgICAgICAgICAgIHRpbWVzdGFtcDogRGF0ZS5ub3coKSxcbiAgICAgICAgICAgIGNvbGxlY3Q6IGNvbGxlY3RcbiAgICAgICAgfSk7XG4gICAgICAgIGlmICghc2NoZWR1bGVkKSB7XG4gICAgICAgICAgICBzZXJ2aWNlLnNjaGVkdWxlKCk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBmdW5jdGlvbiBzY2hlZHVsZSgpIHtcbiAgICAgICAgaWYgKCFzZWNvbmRzKSB7XG4gICAgICAgICAgICBzZXJ2aWNlLnJ1bigpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIHNjaGVkdWxlZCA9IHRydWU7XG4gICAgICAgIHNldFRpbWVvdXQoZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgc2VydmljZS5ydW4oKTtcbiAgICAgICAgICAgIGlmIChpdGVtcy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICAgICAgc2NoZWR1bGUoKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgc2NoZWR1bGVkID0gZmFsc2U7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0sIHNlY29uZHMgKiAxMDAwKTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBydW4oKSB7XG4gICAgICAgIHZhciB0aW1lb3V0ID0gRGF0ZS5ub3coKSAtIHNlY29uZHMgKiAxMDAwO1xuICAgICAgICB3aGlsZSAoaXRlbXMubGVuZ3RoID4gMCAmJiBpdGVtc1swXS50aW1lc3RhbXAgPD0gdGltZW91dCkge1xuICAgICAgICAgICAgaXRlbXMuc2hpZnQoKS5jb2xsZWN0KCk7XG4gICAgICAgIH1cbiAgICB9XG59XG59KCkpO1xuXG4oZnVuY3Rpb24oKSB7XG5cInVzZSBzdHJpY3RcIjtcblxuYW5ndWxhclxuICAgIC5tb2R1bGUoJ3N5bmMnKVxuICAgIC5mYWN0b3J5KCckc3luY01lcmdlJywgc3luY01lcmdlKTtcblxuZnVuY3Rpb24gc3luY01lcmdlKCkge1xuXG4gICAgcmV0dXJuIHtcbiAgICAgICAgbWVyZ2U6IG1lcmdlT2JqZWN0LFxuICAgICAgICBjbGVhck9iamVjdDogY2xlYXJPYmplY3RcbiAgICB9XG5cblxuICAgIC8qKiBtZXJnZSBhbiBvYmplY3Qgd2l0aCBhbiBvdGhlci4gTWVyZ2UgYWxzbyBpbm5lciBvYmplY3RzIGFuZCBvYmplY3RzIGluIGFycmF5LiBcbiAgICAgKiBSZWZlcmVuY2UgdG8gdGhlIG9yaWdpbmFsIG9iamVjdHMgYXJlIG1haW50YWluZWQgaW4gdGhlIGRlc3RpbmF0aW9uIG9iamVjdC5cbiAgICAgKiBPbmx5IGNvbnRlbnQgaXMgdXBkYXRlZC5cbiAgICAgKlxuICAgICAqQHBhcmFtIDxvYmplY3Q+IGRlc3RpbmF0aW9uICBvYmplY3QgdG8gbWVyZ2UgaW50b1xuICAgICAqQHBhcmFtIDxvYmplY3Q+IGRlc3RpbmF0aW9uICBvYmplY3QgdG8gbWVyZ2UgaW50b1xuICAgICAqQHBhcmFtIDxib29sZWFuPiBpc1N0cmljdE1vZGUgZGVmYXVsdCBmYWxzZSwgaWYgdHJ1ZSB3b3VsZCBnZW5lcmF0ZSBhbiBlcnJvciBpZiBpbm5lciBvYmplY3RzIGluIGFycmF5IGRvIG5vdCBoYXZlIGlkIGZpZWxkXG4gICAgICovXG4gICAgZnVuY3Rpb24gbWVyZ2VPYmplY3QoZGVzdGluYXRpb24sIHNvdXJjZSwgaXNTdHJpY3RNb2RlKSB7XG4gICAgICAgIGlmICghZGVzdGluYXRpb24pIHtcbiAgICAgICAgICAgIHJldHVybiBzb3VyY2U7Ly8gXy5hc3NpZ24oe30sIHNvdXJjZSk7O1xuICAgICAgICB9XG4gICAgICAgIC8vIGNyZWF0ZSBuZXcgb2JqZWN0IGNvbnRhaW5pbmcgb25seSB0aGUgcHJvcGVydGllcyBvZiBzb3VyY2UgbWVyZ2Ugd2l0aCBkZXN0aW5hdGlvblxuICAgICAgICB2YXIgb2JqZWN0ID0ge307XG4gICAgICAgIGZvciAodmFyIHByb3BlcnR5IGluIHNvdXJjZSkge1xuICAgICAgICAgICAgaWYgKF8uaXNBcnJheShzb3VyY2VbcHJvcGVydHldKSkge1xuICAgICAgICAgICAgICAgIG9iamVjdFtwcm9wZXJ0eV0gPSBtZXJnZUFycmF5KGRlc3RpbmF0aW9uW3Byb3BlcnR5XSwgc291cmNlW3Byb3BlcnR5XSwgaXNTdHJpY3RNb2RlKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoXy5pc0Z1bmN0aW9uKHNvdXJjZVtwcm9wZXJ0eV0pKSB7XG4gICAgICAgICAgICAgICAgb2JqZWN0W3Byb3BlcnR5XSA9IHNvdXJjZVtwcm9wZXJ0eV07XG4gICAgICAgICAgICB9IGVsc2UgaWYgKF8uaXNPYmplY3Qoc291cmNlW3Byb3BlcnR5XSkpIHtcbiAgICAgICAgICAgICAgICBvYmplY3RbcHJvcGVydHldID0gbWVyZ2VPYmplY3QoZGVzdGluYXRpb25bcHJvcGVydHldLCBzb3VyY2VbcHJvcGVydHldLCBpc1N0cmljdE1vZGUpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBvYmplY3RbcHJvcGVydHldID0gc291cmNlW3Byb3BlcnR5XTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGNsZWFyT2JqZWN0KGRlc3RpbmF0aW9uKTtcbiAgICAgICAgXy5hc3NpZ24oZGVzdGluYXRpb24sIG9iamVjdCk7XG5cbiAgICAgICAgcmV0dXJuIGRlc3RpbmF0aW9uO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIG1lcmdlQXJyYXkoZGVzdGluYXRpb24sIHNvdXJjZSwgaXNTdHJpY3RNb2RlKSB7XG4gICAgICAgIGlmICghZGVzdGluYXRpb24pIHtcbiAgICAgICAgICAgIHJldHVybiBzb3VyY2U7XG4gICAgICAgIH1cbiAgICAgICAgdmFyIGFycmF5ID0gW107XG4gICAgICAgIHNvdXJjZS5mb3JFYWNoKGZ1bmN0aW9uIChpdGVtKSB7XG4gICAgICAgICAgICBpZiAoIWlzU3RyaWN0TW9kZSkge1xuICAgICAgICAgICAgICAgIGFycmF5LnB1c2goaXRlbSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIC8vIFFVSUNLIEZJWDogSSBoYWQgdG8gcmVtb3ZlIHRoaXMgY29kZS4uLi4gc2luY2Ugc3VydmV5IGRvZXMgbm90IHdvcmsuLi5cbiAgICAgICAgICAgICAgICAvL1xuICAgICAgICAgICAgICAgIC8vIG9iamVjdCBpbiBhcnJheSBtdXN0IGhhdmUgYW4gaWQgb3RoZXJ3aXNlIHdlIGNhbid0IG1haW50YWluIHRoZSBpbnN0YW5jZSByZWZlcmVuY2VcbiAgICAgICAgICAgICAgICBpZiAoIV8uaXNBcnJheShpdGVtKSAmJiBfLmlzT2JqZWN0KGl0ZW0pKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIGxldCB0cnkgdG8gZmluZCB0aGUgaW5zdGFuY2VcbiAgICAgICAgICAgICAgICAgICAgaWYgKGFuZ3VsYXIuaXNEZWZpbmVkKGl0ZW0uaWQpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBhcnJheS5wdXNoKG1lcmdlT2JqZWN0KF8uZmluZChkZXN0aW5hdGlvbiwgeyBpZDogaXRlbS5pZCB9KSwgaXRlbSwgaXNTdHJpY3RNb2RlKSk7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoaXNTdHJpY3RNb2RlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdvYmplY3RzIGluIGFycmF5IG11c3QgaGF2ZSBhbiBpZCBvdGhlcndpc2Ugd2UgY2FuXFwndCBtYWludGFpbiB0aGUgaW5zdGFuY2UgcmVmZXJlbmNlLiAnICsgSlNPTi5zdHJpbmdpZnkoaXRlbSkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgYXJyYXkucHVzaChpdGVtKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIGFycmF5LnB1c2goaXRlbSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICBkZXN0aW5hdGlvbi5sZW5ndGggPSAwO1xuICAgICAgICBBcnJheS5wcm90b3R5cGUucHVzaC5hcHBseShkZXN0aW5hdGlvbiwgYXJyYXkpO1xuICAgICAgICAvL2FuZ3VsYXIuY29weShkZXN0aW5hdGlvbiwgYXJyYXkpO1xuICAgICAgICByZXR1cm4gZGVzdGluYXRpb247XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gY2xlYXJPYmplY3Qob2JqZWN0KSB7XG4gICAgICAgIE9iamVjdC5rZXlzKG9iamVjdCkuZm9yRWFjaChmdW5jdGlvbiAoa2V5KSB7IGRlbGV0ZSBvYmplY3Rba2V5XTsgfSk7XG4gICAgfVxufTtcbn0oKSk7XG5cbihmdW5jdGlvbigpIHtcblwidXNlIHN0cmljdFwiO1xuXG4vKipcbiAqIFxuICogU2VydmljZSB0aGF0IGFsbG93cyBhbiBhcnJheSBvZiBkYXRhIHJlbWFpbiBpbiBzeW5jIHdpdGggYmFja2VuZC5cbiAqIFxuICogXG4gKiBleDpcbiAqIHdoZW4gdGhlcmUgaXMgYSBub3RpZmljYXRpb24sIG5vdGljYXRpb25TZXJ2aWNlIG5vdGlmaWVzIHRoYXQgdGhlcmUgaXMgc29tZXRoaW5nIG5ldy4uLnRoZW4gdGhlIGRhdGFzZXQgZ2V0IHRoZSBkYXRhIGFuZCBub3RpZmllcyBhbGwgaXRzIGNhbGxiYWNrLlxuICogXG4gKiBOT1RFOiBcbiAqICBcbiAqIFxuICogUHJlLVJlcXVpc3RlOlxuICogLS0tLS0tLS0tLS0tLVxuICogU3luYyBkb2VzIG5vdCB3b3JrIGlmIG9iamVjdHMgZG8gbm90IGhhdmUgQk9USCBpZCBhbmQgcmV2aXNpb24gZmllbGQhISEhXG4gKiBcbiAqIFdoZW4gdGhlIGJhY2tlbmQgd3JpdGVzIGFueSBkYXRhIHRvIHRoZSBkYiB0aGF0IGFyZSBzdXBwb3NlZCB0byBiZSBzeW5jcm9uaXplZDpcbiAqIEl0IG11c3QgbWFrZSBzdXJlIGVhY2ggYWRkLCB1cGRhdGUsIHJlbW92YWwgb2YgcmVjb3JkIGlzIHRpbWVzdGFtcGVkLlxuICogSXQgbXVzdCBub3RpZnkgdGhlIGRhdGFzdHJlYW0gKHdpdGggbm90aWZ5Q2hhbmdlIG9yIG5vdGlmeVJlbW92YWwpIHdpdGggc29tZSBwYXJhbXMgc28gdGhhdCBiYWNrZW5kIGtub3dzIHRoYXQgaXQgaGFzIHRvIHB1c2ggYmFjayB0aGUgZGF0YSBiYWNrIHRvIHRoZSBzdWJzY3JpYmVycyAoZXg6IHRoZSB0YXNrQ3JlYXRpb24gd291bGQgbm90aWZ5IHdpdGggaXRzIHBsYW5JZClcbiogXG4gKiBcbiAqL1xuYW5ndWxhclxuICAgIC5tb2R1bGUoJ3N5bmMnKVxuICAgIC5wcm92aWRlcignJHN5bmMnLCBzeW5jUHJvdmlkZXIpO1xuXG5mdW5jdGlvbiBzeW5jUHJvdmlkZXIoKSB7XG5cbiAgICB2YXIgZGVidWc7XG5cbiAgICB0aGlzLnNldERlYnVnID0gZnVuY3Rpb24gKHZhbHVlKSB7XG4gICAgICAgIGRlYnVnID0gdmFsdWU7XG4gICAgfTtcblxuICAgIHRoaXMuJGdldCA9IGZ1bmN0aW9uIHN5bmMoJHJvb3RTY29wZSwgJHEsICRzb2NrZXRpbywgJHN5bmNHYXJiYWdlQ29sbGVjdG9yLCAkc3luY01lcmdlKSB7XG5cbiAgICAgICAgdmFyIHB1YmxpY2F0aW9uTGlzdGVuZXJzID0ge30sXG4gICAgICAgICAgICBwdWJsaWNhdGlvbkxpc3RlbmVyQ291bnQgPSAwO1xuICAgICAgICB2YXIgR1JBQ0VfUEVSSU9EX0lOX1NFQ09ORFMgPSA4O1xuICAgICAgICB2YXIgU1lOQ19WRVJTSU9OID0gJzEuMSc7XG5cblxuICAgICAgICBsaXN0ZW5Ub1N5bmNOb3RpZmljYXRpb24oKTtcblxuICAgICAgICB2YXIgc2VydmljZSA9IHtcbiAgICAgICAgICAgIHN1YnNjcmliZTogc3Vic2NyaWJlLFxuICAgICAgICAgICAgcmVzb2x2ZVN1YnNjcmlwdGlvbjogcmVzb2x2ZVN1YnNjcmlwdGlvbixcbiAgICAgICAgICAgIGdldEdyYWNlUGVyaW9kOiBnZXRHcmFjZVBlcmlvZFxuICAgICAgICB9O1xuXG4gICAgICAgIHJldHVybiBzZXJ2aWNlO1xuXG4gICAgICAgIC8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vXG4gICAgICAgIC8qKlxuICAgICAgICAgKiBzdWJzY3JpYmUgdG8gcHVibGljYXRpb24gYW5kIHJldHVybnMgdGhlIHN1YnNjcmlwdGlvbiB3aGVuIGRhdGEgaXMgYXZhaWxhYmxlLiBcbiAgICAgICAgICogQHBhcmFtIHB1YmxpY2F0aW9uIG5hbWUuIG9uIHRoZSBzZXJ2ZXIgc2lkZSwgYSBwdWJsaWNhdGlvbiBzaGFsbCBleGlzdC4gZXg6IG1hZ2F6aW5lcy5zeW5jXG4gICAgICAgICAqIEBwYXJhbSBwYXJhbXMgICB0aGUgcGFyYW1zIG9iamVjdCBwYXNzZWQgdG8gdGhlIHN1YnNjcmlwdGlvbiwgZXg6IHttYWdhemluZUlkOidlbnRyZXByZW5ldXInfSlcbiAgICAgICAgICogQHBhcmFtIG9iamVjdENsYXNzIGFuIGluc3RhbmNlIG9mIHRoaXMgY2xhc3Mgd2lsbCBiZSBjcmVhdGVkIGZvciBlYWNoIHJlY29yZCByZWNlaXZlZC5cbiAgICAgICAgICogcmV0dXJucyBhIHByb21pc2UgcmV0dXJuaW5nIHRoZSBzdWJzY3JpcHRpb24gd2hlbiB0aGUgZGF0YSBpcyBzeW5jZWRcbiAgICAgICAgICogb3IgcmVqZWN0cyBpZiB0aGUgaW5pdGlhbCBzeW5jIGZhaWxzIHRvIGNvbXBsZXRlIGluIGEgbGltaXRlZCBhbW91bnQgb2YgdGltZS4gXG4gICAgICAgICAqIFxuICAgICAgICAgKiB0byBnZXQgdGhlIGRhdGEgZnJvbSB0aGUgZGF0YVNldCwganVzdCBkYXRhU2V0LmdldERhdGEoKVxuICAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gcmVzb2x2ZVN1YnNjcmlwdGlvbihwdWJsaWNhdGlvbk5hbWUsIHBhcmFtcywgb2JqZWN0Q2xhc3MpIHtcbiAgICAgICAgICAgIHZhciBkZWZlcnJlZCA9ICRxLmRlZmVyKCk7XG4gICAgICAgICAgICB2YXIgc0RzID0gc3Vic2NyaWJlKHB1YmxpY2F0aW9uTmFtZSkuc2V0T2JqZWN0Q2xhc3Mob2JqZWN0Q2xhc3MpO1xuXG4gICAgICAgICAgICAvLyBnaXZlIGEgbGl0dGxlIHRpbWUgZm9yIHN1YnNjcmlwdGlvbiB0byBmZXRjaCB0aGUgZGF0YS4uLm90aGVyd2lzZSBnaXZlIHVwIHNvIHRoYXQgd2UgZG9uJ3QgZ2V0IHN0dWNrIGluIGEgcmVzb2x2ZSB3YWl0aW5nIGZvcmV2ZXIuXG4gICAgICAgICAgICB2YXIgZ3JhY2VQZXJpb2QgPSBzZXRUaW1lb3V0KGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICBpZiAoIXNEcy5yZWFkeSkge1xuICAgICAgICAgICAgICAgICAgICBzRHMuZGVzdHJveSgpO1xuICAgICAgICAgICAgICAgICAgICBsb2dJbmZvKCdBdHRlbXB0IHRvIHN1YnNjcmliZSB0byBwdWJsaWNhdGlvbiAnICsgcHVibGljYXRpb25OYW1lICsgJyBmYWlsZWQnKTtcbiAgICAgICAgICAgICAgICAgICAgZGVmZXJyZWQucmVqZWN0KCdTWU5DX1RJTUVPVVQnKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9LCBHUkFDRV9QRVJJT0RfSU5fU0VDT05EUyAqIDEwMDApO1xuXG4gICAgICAgICAgICBzRHMuc2V0UGFyYW1ldGVycyhwYXJhbXMpXG4gICAgICAgICAgICAgICAgLndhaXRGb3JEYXRhUmVhZHkoKVxuICAgICAgICAgICAgICAgIC50aGVuKGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICAgICAgY2xlYXJUaW1lb3V0KGdyYWNlUGVyaW9kKTtcbiAgICAgICAgICAgICAgICAgICAgZGVmZXJyZWQucmVzb2x2ZShzRHMpO1xuICAgICAgICAgICAgICAgIH0pLmNhdGNoKGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICAgICAgY2xlYXJUaW1lb3V0KGdyYWNlUGVyaW9kKTtcbiAgICAgICAgICAgICAgICAgICAgc0RzLmRlc3Ryb3koKTtcbiAgICAgICAgICAgICAgICAgICAgZGVmZXJyZWQucmVqZWN0KCdGYWlsZWQgdG8gc3Vic2NyaWJlIHRvIHB1YmxpY2F0aW9uICcgKyBwdWJsaWNhdGlvbk5hbWUgKyAnIGZhaWxlZCcpO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgcmV0dXJuIGRlZmVycmVkLnByb21pc2U7XG4gICAgICAgIH1cblxuICAgICAgICAvKipcbiAgICAgICAgICogXG4gICAgICAgICAqIGZvciB0ZXN0IHB1cnBvc2VzLCByZXR1cm5zIHRoZSB0aW1lIHJlc29sdmVTdWJzY3JpcHRpb24gYmVmb3JlIGl0IHRpbWVzIG91dC5cbiAgICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIGdldEdyYWNlUGVyaW9kKCkge1xuICAgICAgICAgICAgcmV0dXJuIEdSQUNFX1BFUklPRF9JTl9TRUNPTkRTO1xuICAgICAgICB9XG4gICAgICAgIC8qKlxuICAgICAgICAgKiBzdWJzY3JpYmUgdG8gcHVibGljYXRpb24uIEl0IHdpbGwgbm90IHN5bmMgdW50aWwgeW91IHNldCB0aGUgcGFyYW1zLlxuICAgICAgICAgKiBcbiAgICAgICAgICogQHBhcmFtIHB1YmxpY2F0aW9uIG5hbWUuIG9uIHRoZSBzZXJ2ZXIgc2lkZSwgYSBwdWJsaWNhdGlvbiBzaGFsbCBleGlzdC4gZXg6IG1hZ2F6aW5lcy5zeW5jXG4gICAgICAgICAqIEBwYXJhbSBwYXJhbXMgICB0aGUgcGFyYW1zIG9iamVjdCBwYXNzZWQgdG8gdGhlIHN1YnNjcmlwdGlvbiwgZXg6IHttYWdhemluZUlkOidlbnRyZXByZW5ldXInfSlcbiAgICAgICAgICogcmV0dXJucyBzdWJzY3JpcHRpb25cbiAgICAgICAgICogXG4gICAgICAgICAqL1xuICAgICAgICBmdW5jdGlvbiBzdWJzY3JpYmUocHVibGljYXRpb25OYW1lLCBzY29wZSkge1xuICAgICAgICAgICAgcmV0dXJuIG5ldyBTdWJzY3JpcHRpb24ocHVibGljYXRpb25OYW1lLCBzY29wZSk7XG4gICAgICAgIH1cblxuXG5cbiAgICAgICAgLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy9cbiAgICAgICAgLy8gSEVMUEVSU1xuXG4gICAgICAgIC8vIGV2ZXJ5IHN5bmMgbm90aWZpY2F0aW9uIGNvbWVzIHRocnUgdGhlIHNhbWUgZXZlbnQgdGhlbiBpdCBpcyBkaXNwYXRjaGVzIHRvIHRoZSB0YXJnZXRlZCBzdWJzY3JpcHRpb25zLlxuICAgICAgICBmdW5jdGlvbiBsaXN0ZW5Ub1N5bmNOb3RpZmljYXRpb24oKSB7XG4gICAgICAgICAgICAkc29ja2V0aW8ub24oJ1NZTkNfTk9XJywgZnVuY3Rpb24gKHN1Yk5vdGlmaWNhdGlvbiwgZm4pIHtcbiAgICAgICAgICAgICAgICBsb2dJbmZvKCdTeW5jaW5nIHdpdGggc3Vic2NyaXB0aW9uIFtuYW1lOicgKyBzdWJOb3RpZmljYXRpb24ubmFtZSArICcsIGlkOicgKyBzdWJOb3RpZmljYXRpb24uc3Vic2NyaXB0aW9uSWQgKyAnICwgcGFyYW1zOicgKyBKU09OLnN0cmluZ2lmeShzdWJOb3RpZmljYXRpb24ucGFyYW1zKSArICddLiBSZWNvcmRzOicgKyBzdWJOb3RpZmljYXRpb24ucmVjb3Jkcy5sZW5ndGggKyAnWycgKyAoc3ViTm90aWZpY2F0aW9uLmRpZmYgPyAnRGlmZicgOiAnQWxsJykgKyAnXScpO1xuICAgICAgICAgICAgICAgIHZhciBsaXN0ZW5lcnMgPSBwdWJsaWNhdGlvbkxpc3RlbmVyc1tzdWJOb3RpZmljYXRpb24ubmFtZV07XG4gICAgICAgICAgICAgICAgaWYgKGxpc3RlbmVycykge1xuICAgICAgICAgICAgICAgICAgICBmb3IgKHZhciBsaXN0ZW5lciBpbiBsaXN0ZW5lcnMpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxpc3RlbmVyc1tsaXN0ZW5lcl0oc3ViTm90aWZpY2F0aW9uKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBmbignU1lOQ0VEJyk7IC8vIGxldCBrbm93IHRoZSBiYWNrZW5kIHRoZSBjbGllbnQgd2FzIGFibGUgdG8gc3luYy5cbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9O1xuXG5cbiAgICAgICAgLy8gdGhpcyBhbGxvd3MgYSBkYXRhc2V0IHRvIGxpc3RlbiB0byBhbnkgU1lOQ19OT1cgZXZlbnQuLmFuZCBpZiB0aGUgbm90aWZpY2F0aW9uIGlzIGFib3V0IGl0cyBkYXRhLlxuICAgICAgICBmdW5jdGlvbiBhZGRQdWJsaWNhdGlvbkxpc3RlbmVyKHN0cmVhbU5hbWUsIGNhbGxiYWNrKSB7XG4gICAgICAgICAgICB2YXIgdWlkID0gcHVibGljYXRpb25MaXN0ZW5lckNvdW50Kys7XG4gICAgICAgICAgICB2YXIgbGlzdGVuZXJzID0gcHVibGljYXRpb25MaXN0ZW5lcnNbc3RyZWFtTmFtZV07XG4gICAgICAgICAgICBpZiAoIWxpc3RlbmVycykge1xuICAgICAgICAgICAgICAgIHB1YmxpY2F0aW9uTGlzdGVuZXJzW3N0cmVhbU5hbWVdID0gbGlzdGVuZXJzID0ge307XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBsaXN0ZW5lcnNbdWlkXSA9IGNhbGxiYWNrO1xuXG4gICAgICAgICAgICByZXR1cm4gZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgIGRlbGV0ZSBsaXN0ZW5lcnNbdWlkXTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAgICAgLy8gU3Vic2NyaXB0aW9uIG9iamVjdFxuICAgICAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAgICAgLyoqXG4gICAgICAgICAqIGEgc3Vic2NyaXB0aW9uIHN5bmNocm9uaXplcyB3aXRoIHRoZSBiYWNrZW5kIGZvciBhbnkgYmFja2VuZCBkYXRhIGNoYW5nZSBhbmQgbWFrZXMgdGhhdCBkYXRhIGF2YWlsYWJsZSB0byBhIGNvbnRyb2xsZXIuXG4gICAgICAgICAqIFxuICAgICAgICAgKiAgV2hlbiBjbGllbnQgc3Vic2NyaWJlcyB0byBhbiBzeW5jcm9uaXplZCBhcGksIGFueSBkYXRhIGNoYW5nZSB0aGF0IGltcGFjdHMgdGhlIGFwaSByZXN1bHQgV0lMTCBiZSBQVVNIZWQgdG8gdGhlIGNsaWVudC5cbiAgICAgICAgICogSWYgdGhlIGNsaWVudCBkb2VzIE5PVCBzdWJzY3JpYmUgb3Igc3RvcCBzdWJzY3JpYmUsIGl0IHdpbGwgbm8gbG9uZ2VyIHJlY2VpdmUgdGhlIFBVU0guIFxuICAgICAgICAgKiAgICBcbiAgICAgICAgICogaWYgdGhlIGNvbm5lY3Rpb24gaXMgbG9zdCBmb3IgYSBzaG9ydCB0aW1lIChkdXJhdGlvbiBkZWZpbmVkIG9uIHNlcnZlci1zaWRlKSwgdGhlIHNlcnZlciBxdWV1ZXMgdGhlIGNoYW5nZXMgaWYgYW55LiBcbiAgICAgICAgICogV2hlbiB0aGUgY29ubmVjdGlvbiByZXR1cm5zLCB0aGUgbWlzc2luZyBkYXRhIGF1dG9tYXRpY2FsbHkgIHdpbGwgYmUgUFVTSGVkIHRvIHRoZSBzdWJzY3JpYmluZyBjbGllbnQuXG4gICAgICAgICAqIGlmIHRoZSBjb25uZWN0aW9uIGlzIGxvc3QgZm9yIGEgbG9uZyB0aW1lIChkdXJhdGlvbiBkZWZpbmVkIG9uIHRoZSBzZXJ2ZXIpLCB0aGUgc2VydmVyIHdpbGwgZGVzdHJveSB0aGUgc3Vic2NyaXB0aW9uLiBUbyBzaW1wbGlmeSwgdGhlIGNsaWVudCB3aWxsIHJlc3Vic2NyaWJlIGF0IGl0cyByZWNvbm5lY3Rpb24gYW5kIGdldCBhbGwgZGF0YS5cbiAgICAgICAgICogXG4gICAgICAgICAqIHN1YnNjcmlwdGlvbiBvYmplY3QgcHJvdmlkZXMgMyBjYWxsYmFja3MgKGFkZCx1cGRhdGUsIGRlbCkgd2hpY2ggYXJlIGNhbGxlZCBkdXJpbmcgc3luY2hyb25pemF0aW9uLlxuICAgICAgICAgKiAgICAgIFxuICAgICAgICAgKiBTY29wZSB3aWxsIGFsbG93IHRoZSBzdWJzY3JpcHRpb24gc3RvcCBzeW5jaHJvbml6aW5nIGFuZCBjYW5jZWwgcmVnaXN0cmF0aW9uIHdoZW4gaXQgaXMgZGVzdHJveWVkLiBcbiAgICAgICAgICogIFxuICAgICAgICAgKiBDb25zdHJ1Y3RvcjpcbiAgICAgICAgICogXG4gICAgICAgICAqIEBwYXJhbSBwdWJsaWNhdGlvbiwgdGhlIHB1YmxpY2F0aW9uIG11c3QgZXhpc3Qgb24gdGhlIHNlcnZlciBzaWRlXG4gICAgICAgICAqIEBwYXJhbSBzY29wZSwgYnkgZGVmYXVsdCAkcm9vdFNjb3BlLCBidXQgY2FuIGJlIG1vZGlmaWVkIGxhdGVyIG9uIHdpdGggYXR0YWNoIG1ldGhvZC5cbiAgICAgICAgICovXG5cbiAgICAgICAgZnVuY3Rpb24gU3Vic2NyaXB0aW9uKHB1YmxpY2F0aW9uLCBzY29wZSkge1xuICAgICAgICAgICAgdmFyIHRpbWVzdGFtcEZpZWxkLCBpc1N5bmNpbmdPbiA9IGZhbHNlLCBpc1NpbmdsZSwgdXBkYXRlRGF0YVN0b3JhZ2UsIGNhY2hlLCBpc0luaXRpYWxQdXNoQ29tcGxldGVkLCBkZWZlcnJlZEluaXRpYWxpemF0aW9uLCBzdHJpY3RNb2RlO1xuICAgICAgICAgICAgdmFyIG9uUmVhZHlPZmYsIGZvcm1hdFJlY29yZDtcbiAgICAgICAgICAgIHZhciByZWNvbm5lY3RPZmYsIHB1YmxpY2F0aW9uTGlzdGVuZXJPZmYsIGRlc3Ryb3lPZmY7XG4gICAgICAgICAgICB2YXIgb2JqZWN0Q2xhc3M7XG4gICAgICAgICAgICB2YXIgc3Vic2NyaXB0aW9uSWQ7XG5cbiAgICAgICAgICAgIHZhciBzRHMgPSB0aGlzO1xuICAgICAgICAgICAgdmFyIHN1YlBhcmFtcyA9IHt9O1xuICAgICAgICAgICAgdmFyIHJlY29yZFN0YXRlcyA9IHt9O1xuICAgICAgICAgICAgdmFyIGlubmVyU2NvcGU7Ly89ICRyb290U2NvcGUuJG5ldyh0cnVlKTtcbiAgICAgICAgICAgIHZhciBzeW5jTGlzdGVuZXIgPSBuZXcgU3luY0xpc3RlbmVyKCk7XG5cblxuICAgICAgICAgICAgdGhpcy5yZWFkeSA9IGZhbHNlO1xuICAgICAgICAgICAgdGhpcy5zeW5jT24gPSBzeW5jT247XG4gICAgICAgICAgICB0aGlzLnN5bmNPZmYgPSBzeW5jT2ZmO1xuICAgICAgICAgICAgdGhpcy5zZXRPblJlYWR5ID0gc2V0T25SZWFkeTtcblxuICAgICAgICAgICAgdGhpcy5vblJlYWR5ID0gb25SZWFkeTtcbiAgICAgICAgICAgIHRoaXMub25VcGRhdGUgPSBvblVwZGF0ZTtcbiAgICAgICAgICAgIHRoaXMub25BZGQgPSBvbkFkZDtcbiAgICAgICAgICAgIHRoaXMub25SZW1vdmUgPSBvblJlbW92ZTtcblxuICAgICAgICAgICAgdGhpcy5nZXREYXRhID0gZ2V0RGF0YTtcbiAgICAgICAgICAgIHRoaXMuc2V0UGFyYW1ldGVycyA9IHNldFBhcmFtZXRlcnM7XG5cbiAgICAgICAgICAgIHRoaXMud2FpdEZvckRhdGFSZWFkeSA9IHdhaXRGb3JEYXRhUmVhZHk7XG4gICAgICAgICAgICB0aGlzLndhaXRGb3JTdWJzY3JpcHRpb25SZWFkeSA9IHdhaXRGb3JTdWJzY3JpcHRpb25SZWFkeTtcblxuICAgICAgICAgICAgdGhpcy5zZXRGb3JjZSA9IHNldEZvcmNlO1xuICAgICAgICAgICAgdGhpcy5pc1N5bmNpbmcgPSBpc1N5bmNpbmc7XG4gICAgICAgICAgICB0aGlzLmlzUmVhZHkgPSBpc1JlYWR5O1xuXG4gICAgICAgICAgICB0aGlzLnNldFNpbmdsZSA9IHNldFNpbmdsZTtcblxuICAgICAgICAgICAgdGhpcy5zZXRPYmplY3RDbGFzcyA9IHNldE9iamVjdENsYXNzO1xuICAgICAgICAgICAgdGhpcy5nZXRPYmplY3RDbGFzcyA9IGdldE9iamVjdENsYXNzO1xuXG4gICAgICAgICAgICB0aGlzLnNldFN0cmljdE1vZGUgPSBzZXRTdHJpY3RNb2RlO1xuXG4gICAgICAgICAgICB0aGlzLmF0dGFjaCA9IGF0dGFjaDtcbiAgICAgICAgICAgIHRoaXMuZGVzdHJveSA9IGRlc3Ryb3k7XG5cbiAgICAgICAgICAgIHRoaXMuaXNFeGlzdGluZ1N0YXRlRm9yID0gaXNFeGlzdGluZ1N0YXRlRm9yOyAvLyBmb3IgdGVzdGluZyBwdXJwb3Nlc1xuXG4gICAgICAgICAgICBzZXRTaW5nbGUoZmFsc2UpO1xuXG4gICAgICAgICAgICAvLyB0aGlzIHdpbGwgbWFrZSBzdXJlIHRoYXQgdGhlIHN1YnNjcmlwdGlvbiBpcyByZWxlYXNlZCBmcm9tIHNlcnZlcnMgaWYgdGhlIGFwcCBjbG9zZXMgKGNsb3NlIGJyb3dzZXIsIHJlZnJlc2guLi4pXG4gICAgICAgICAgICBhdHRhY2goc2NvcGUgfHwgJHJvb3RTY29wZSk7XG5cbiAgICAgICAgICAgIC8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy9cblxuICAgICAgICAgICAgZnVuY3Rpb24gZGVzdHJveSgpIHtcbiAgICAgICAgICAgICAgICBzeW5jT2ZmKCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKiB0aGlzIHdpbGwgYmUgY2FsbGVkIHdoZW4gZGF0YSBpcyBhdmFpbGFibGUgXG4gICAgICAgICAgICAgKiAgaXQgbWVhbnMgcmlnaHQgYWZ0ZXIgZWFjaCBzeW5jIVxuICAgICAgICAgICAgICogXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBzZXRPblJlYWR5KGNhbGxiYWNrKSB7XG4gICAgICAgICAgICAgICAgaWYgKG9uUmVhZHlPZmYpIHtcbiAgICAgICAgICAgICAgICAgICAgb25SZWFkeU9mZigpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBvblJlYWR5T2ZmID0gb25SZWFkeShjYWxsYmFjayk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgKiBmb3JjZSByZXN5bmNpbmcgZnJvbSBzY3JhdGNoIGV2ZW4gaWYgdGhlIHBhcmFtZXRlcnMgaGF2ZSBub3QgY2hhbmdlZFxuICAgICAgICAgICAgICogXG4gICAgICAgICAgICAgKiBpZiBvdXRzaWRlIGNvZGUgaGFzIG1vZGlmaWVkIHRoZSBkYXRhIGFuZCB5b3UgbmVlZCB0byByb2xsYmFjaywgeW91IGNvdWxkIGNvbnNpZGVyIGZvcmNpbmcgYSByZWZyZXNoIHdpdGggdGhpcy4gQmV0dGVyIHNvbHV0aW9uIHNob3VsZCBiZSBmb3VuZCB0aGFuIHRoYXQuXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICAqL1xuICAgICAgICAgICAgZnVuY3Rpb24gc2V0Rm9yY2UodmFsdWUpIHtcbiAgICAgICAgICAgICAgICBpZiAodmFsdWUpIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gcXVpY2sgaGFjayB0byBmb3JjZSB0byByZWxvYWQuLi5yZWNvZGUgbGF0ZXIuXG4gICAgICAgICAgICAgICAgICAgIHNEcy5zeW5jT2ZmKCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogaWYgc2V0IHRvIHRydWUsIGlmIGFuIG9iamVjdCB3aXRoaW4gYW4gYXJyYXkgcHJvcGVydHkgb2YgdGhlIHJlY29yZCB0byBzeW5jIGhhcyBubyBJRCBmaWVsZC5cbiAgICAgICAgICAgICAqIGFuIGVycm9yIHdvdWxkIGJlIHRocm93bi5cbiAgICAgICAgICAgICAqIEl0IGlzIGltcG9ydGFudCBpZiB3ZSB3YW50IHRvIGJlIGFibGUgdG8gbWFpbnRhaW4gaW5zdGFuY2UgcmVmZXJlbmNlcyBldmVuIGZvciB0aGUgb2JqZWN0cyBpbnNpZGUgYXJyYXlzLlxuICAgICAgICAgICAgICpcbiAgICAgICAgICAgICAqIEZvcmNlcyB1cyB0byB1c2UgaWQgZXZlcnkgd2hlcmUuXG4gICAgICAgICAgICAgKlxuICAgICAgICAgICAgICogU2hvdWxkIGJlIHRoZSBkZWZhdWx0Li4uYnV0IHRvbyByZXN0cmljdGl2ZSBmb3Igbm93LlxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBzZXRTdHJpY3RNb2RlKHZhbHVlKSB7XG4gICAgICAgICAgICAgICAgc3RyaWN0TW9kZSA9IHRydWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogVGhlIGZvbGxvd2luZyBvYmplY3Qgd2lsbCBiZSBidWlsdCB1cG9uIGVhY2ggcmVjb3JkIHJlY2VpdmVkIGZyb20gdGhlIGJhY2tlbmRcbiAgICAgICAgICAgICAqIFxuICAgICAgICAgICAgICogVGhpcyBjYW5ub3QgYmUgbW9kaWZpZWQgYWZ0ZXIgdGhlIHN5bmMgaGFzIHN0YXJ0ZWQuXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICAqIEBwYXJhbSBjbGFzc1ZhbHVlXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIHNldE9iamVjdENsYXNzKGNsYXNzVmFsdWUpIHtcbiAgICAgICAgICAgICAgICBpZiAoZGVmZXJyZWRJbml0aWFsaXphdGlvbikge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIG9iamVjdENsYXNzID0gY2xhc3NWYWx1ZTtcbiAgICAgICAgICAgICAgICBmb3JtYXRSZWNvcmQgPSBmdW5jdGlvbiAocmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBuZXcgb2JqZWN0Q2xhc3MocmVjb3JkKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgc2V0U2luZ2xlKGlzU2luZ2xlKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBnZXRPYmplY3RDbGFzcygpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gb2JqZWN0Q2xhc3M7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogdGhpcyBmdW5jdGlvbiBzdGFydHMgdGhlIHN5bmNpbmcuXG4gICAgICAgICAgICAgKiBPbmx5IHB1YmxpY2F0aW9uIHB1c2hpbmcgZGF0YSBtYXRjaGluZyBvdXIgZmV0Y2hpbmcgcGFyYW1zIHdpbGwgYmUgcmVjZWl2ZWQuXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICAqIGV4OiBmb3IgYSBwdWJsaWNhdGlvbiBuYW1lZCBcIm1hZ2F6aW5lcy5zeW5jXCIsIGlmIGZldGNoaW5nIHBhcmFtcyBlcXVhbGxlZCB7bWFnYXppbk5hbWU6J2NhcnMnfSwgdGhlIG1hZ2F6aW5lIGNhcnMgZGF0YSB3b3VsZCBiZSByZWNlaXZlZCBieSB0aGlzIHN1YnNjcmlwdGlvbi5cbiAgICAgICAgICAgICAqIFxuICAgICAgICAgICAgICogQHBhcmFtIGZldGNoaW5nUGFyYW1zXG4gICAgICAgICAgICAgKiBAcGFyYW0gb3B0aW9uc1xuICAgICAgICAgICAgICogXG4gICAgICAgICAgICAgKiBAcmV0dXJucyBhIHByb21pc2UgdGhhdCByZXNvbHZlcyB3aGVuIGRhdGEgaXMgYXJyaXZlZC5cbiAgICAgICAgICAgICAqL1xuICAgICAgICAgICAgZnVuY3Rpb24gc2V0UGFyYW1ldGVycyhmZXRjaGluZ1BhcmFtcywgb3B0aW9ucykge1xuICAgICAgICAgICAgICAgIGlmIChpc1N5bmNpbmdPbiAmJiBhbmd1bGFyLmVxdWFscyhmZXRjaGluZ1BhcmFtcywgc3ViUGFyYW1zKSkge1xuICAgICAgICAgICAgICAgICAgICAvLyBpZiB0aGUgcGFyYW1zIGhhdmUgbm90IGNoYW5nZWQsIGp1c3QgcmV0dXJucyB3aXRoIGN1cnJlbnQgZGF0YS5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHNEczsgLy8kcS5yZXNvbHZlKGdldERhdGEoKSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHN5bmNPZmYoKTtcbiAgICAgICAgICAgICAgICBpZiAoIWlzU2luZ2xlKSB7XG4gICAgICAgICAgICAgICAgICAgIGNhY2hlLmxlbmd0aCA9IDA7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgc3ViUGFyYW1zID0gZmV0Y2hpbmdQYXJhbXMgfHwge307XG4gICAgICAgICAgICAgICAgb3B0aW9ucyA9IG9wdGlvbnMgfHwge307XG4gICAgICAgICAgICAgICAgaWYgKGFuZ3VsYXIuaXNEZWZpbmVkKG9wdGlvbnMuc2luZ2xlKSkge1xuICAgICAgICAgICAgICAgICAgICBzZXRTaW5nbGUob3B0aW9ucy5zaW5nbGUpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBzeW5jT24oKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyB3YWl0IGZvciB0aGUgaW5pdGlhbCBmZXRjaCB0byBjb21wbGV0ZSB0aGVuIHJldHVybnMgdGhpcyBzdWJzY3JpcHRpb25cbiAgICAgICAgICAgIGZ1bmN0aW9uIHdhaXRGb3JTdWJzY3JpcHRpb25SZWFkeSgpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZGVmZXJyZWRJbml0aWFsaXphdGlvbi5wcm9taXNlLnRoZW4oZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyB3YWl0IGZvciB0aGUgaW5pdGlhbCBmZXRjaCB0byBjb21wbGV0ZSB0aGVuIHJldHVybnMgdGhlIGRhdGFcbiAgICAgICAgICAgIGZ1bmN0aW9uIHdhaXRGb3JEYXRhUmVhZHkoKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGRlZmVycmVkSW5pdGlhbGl6YXRpb24ucHJvbWlzZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy8gZG9lcyB0aGUgZGF0YXNldCByZXR1cm5zIG9ubHkgb25lIG9iamVjdD8gbm90IGFuIGFycmF5P1xuICAgICAgICAgICAgZnVuY3Rpb24gc2V0U2luZ2xlKHZhbHVlKSB7XG4gICAgICAgICAgICAgICAgaWYgKGRlZmVycmVkSW5pdGlhbGl6YXRpb24pIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICB2YXIgdXBkYXRlRm47XG4gICAgICAgICAgICAgICAgaXNTaW5nbGUgPSB2YWx1ZTtcbiAgICAgICAgICAgICAgICBpZiAodmFsdWUpIHtcbiAgICAgICAgICAgICAgICAgICAgdXBkYXRlRm4gPSB1cGRhdGVTeW5jZWRPYmplY3Q7XG4gICAgICAgICAgICAgICAgICAgIGNhY2hlID0gb2JqZWN0Q2xhc3MgPyBuZXcgb2JqZWN0Q2xhc3Moe30pIDoge307XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgdXBkYXRlRm4gPSB1cGRhdGVTeW5jZWRBcnJheTtcbiAgICAgICAgICAgICAgICAgICAgY2FjaGUgPSBbXTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICB1cGRhdGVEYXRhU3RvcmFnZSA9IGZ1bmN0aW9uIChyZWNvcmQpIHtcbiAgICAgICAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHVwZGF0ZUZuKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGUubWVzc2FnZSA9ICdSZWNlaXZlZCBJbnZhbGlkIG9iamVjdCBmcm9tIHB1YmxpY2F0aW9uIFsnICsgcHVibGljYXRpb24gKyAnXTogJyArIEpTT04uc3RyaW5naWZ5KHJlY29yZCkgKyAnLiBERVRBSUxTOiAnICsgZS5tZXNzYWdlO1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgZTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIHJldHVybnMgdGhlIG9iamVjdCBvciBhcnJheSBpbiBzeW5jXG4gICAgICAgICAgICBmdW5jdGlvbiBnZXREYXRhKCkge1xuICAgICAgICAgICAgICAgIHJldHVybiBjYWNoZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgKiB0aGUgZGF0YXNldCB3aWxsIHN0YXJ0IGxpc3RlbmluZyB0byB0aGUgZGF0YXN0cmVhbSBcbiAgICAgICAgICAgICAqIFxuICAgICAgICAgICAgICogTm90ZSBEdXJpbmcgdGhlIHN5bmMsIGl0IHdpbGwgYWxzbyBjYWxsIHRoZSBvcHRpb25hbCBjYWxsYmFja3MgLSBhZnRlciBwcm9jZXNzaW5nIEVBQ0ggcmVjb3JkIHJlY2VpdmVkLlxuICAgICAgICAgICAgICogXG4gICAgICAgICAgICAgKiBAcmV0dXJucyBhIHByb21pc2UgdGhhdCB3aWxsIGJlIHJlc29sdmVkIHdoZW4gdGhlIGRhdGEgaXMgcmVhZHkuXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIHN5bmNPbigpIHtcbiAgICAgICAgICAgICAgICBpZiAoaXNTeW5jaW5nT24pIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGRlZmVycmVkSW5pdGlhbGl6YXRpb24ucHJvbWlzZTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgZGVmZXJyZWRJbml0aWFsaXphdGlvbiA9ICRxLmRlZmVyKCk7XG4gICAgICAgICAgICAgICAgaXNJbml0aWFsUHVzaENvbXBsZXRlZCA9IGZhbHNlO1xuICAgICAgICAgICAgICAgIGxvZ0luZm8oJ1N5bmMgJyArIHB1YmxpY2F0aW9uICsgJyBvbi4gUGFyYW1zOicgKyBKU09OLnN0cmluZ2lmeShzdWJQYXJhbXMpKTtcbiAgICAgICAgICAgICAgICBpc1N5bmNpbmdPbiA9IHRydWU7XG4gICAgICAgICAgICAgICAgcmVnaXN0ZXJTdWJzY3JpcHRpb24oKTtcbiAgICAgICAgICAgICAgICByZWFkeUZvckxpc3RlbmluZygpO1xuICAgICAgICAgICAgICAgIHJldHVybiBkZWZlcnJlZEluaXRpYWxpemF0aW9uLnByb21pc2U7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogdGhlIGRhdGFzZXQgaXMgbm8gbG9uZ2VyIGxpc3RlbmluZyBhbmQgd2lsbCBub3QgY2FsbCBhbnkgY2FsbGJhY2tcbiAgICAgICAgICAgICAqL1xuICAgICAgICAgICAgZnVuY3Rpb24gc3luY09mZigpIHtcbiAgICAgICAgICAgICAgICBpZiAoZGVmZXJyZWRJbml0aWFsaXphdGlvbikge1xuICAgICAgICAgICAgICAgICAgICAvLyBpZiB0aGVyZSBpcyBjb2RlIHdhaXRpbmcgb24gdGhpcyBwcm9taXNlLi4gZXggKGxvYWQgaW4gcmVzb2x2ZSlcbiAgICAgICAgICAgICAgICAgICAgZGVmZXJyZWRJbml0aWFsaXphdGlvbi5yZXNvbHZlKGdldERhdGEoKSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGlmIChpc1N5bmNpbmdPbikge1xuICAgICAgICAgICAgICAgICAgICB1bnJlZ2lzdGVyU3Vic2NyaXB0aW9uKCk7XG4gICAgICAgICAgICAgICAgICAgIGlzU3luY2luZ09uID0gZmFsc2U7XG5cbiAgICAgICAgICAgICAgICAgICAgbG9nSW5mbygnU3luYyAnICsgcHVibGljYXRpb24gKyAnIG9mZi4gUGFyYW1zOicgKyBKU09OLnN0cmluZ2lmeShzdWJQYXJhbXMpKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHB1YmxpY2F0aW9uTGlzdGVuZXJPZmYpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHB1YmxpY2F0aW9uTGlzdGVuZXJPZmYoKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHB1YmxpY2F0aW9uTGlzdGVuZXJPZmYgPSBudWxsO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIGlmIChyZWNvbm5lY3RPZmYpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJlY29ubmVjdE9mZigpO1xuICAgICAgICAgICAgICAgICAgICAgICAgcmVjb25uZWN0T2ZmID0gbnVsbDtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gaXNTeW5jaW5nKCkge1xuICAgICAgICAgICAgICAgIHJldHVybiBpc1N5bmNpbmdPbjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gcmVhZHlGb3JMaXN0ZW5pbmcoKSB7XG4gICAgICAgICAgICAgICAgaWYgKCFwdWJsaWNhdGlvbkxpc3RlbmVyT2ZmKSB7XG4gICAgICAgICAgICAgICAgICAgIGxpc3RlbkZvclJlY29ubmVjdGlvblRvUmVzeW5jKCk7XG4gICAgICAgICAgICAgICAgICAgIGxpc3RlblRvUHVibGljYXRpb24oKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogIEJ5IGRlZmF1bHQgdGhlIHJvb3RzY29wZSBpcyBhdHRhY2hlZCBpZiBubyBzY29wZSB3YXMgcHJvdmlkZWQuIEJ1dCBpdCBpcyBwb3NzaWJsZSB0byByZS1hdHRhY2ggaXQgdG8gYSBkaWZmZXJlbnQgc2NvcGUuIGlmIHRoZSBzdWJzY3JpcHRpb24gZGVwZW5kcyBvbiBhIGNvbnRyb2xsZXIuXG4gICAgICAgICAgICAgKlxuICAgICAgICAgICAgICogIERvIG5vdCBhdHRhY2ggYWZ0ZXIgaXQgaGFzIHN5bmNlZC5cbiAgICAgICAgICAgICAqL1xuICAgICAgICAgICAgZnVuY3Rpb24gYXR0YWNoKG5ld1Njb3BlKSB7XG4gICAgICAgICAgICAgICAgaWYgKGRlZmVycmVkSW5pdGlhbGl6YXRpb24pIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgaWYgKGRlc3Ryb3lPZmYpIHtcbiAgICAgICAgICAgICAgICAgICAgZGVzdHJveU9mZigpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBpbm5lclNjb3BlID0gbmV3U2NvcGU7XG4gICAgICAgICAgICAgICAgZGVzdHJveU9mZiA9IGlubmVyU2NvcGUuJG9uKCckZGVzdHJveScsIGRlc3Ryb3kpO1xuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gbGlzdGVuRm9yUmVjb25uZWN0aW9uVG9SZXN5bmMobGlzdGVuTm93KSB7XG4gICAgICAgICAgICAgICAgLy8gZ2l2ZSBhIGNoYW5jZSB0byBjb25uZWN0IGJlZm9yZSBsaXN0ZW5pbmcgdG8gcmVjb25uZWN0aW9uLi4uIEBUT0RPIHNob3VsZCBoYXZlIHVzZXJfcmVjb25uZWN0ZWRfZXZlbnRcbiAgICAgICAgICAgICAgICBzZXRUaW1lb3V0KGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICAgICAgcmVjb25uZWN0T2ZmID0gaW5uZXJTY29wZS4kb24oJ3VzZXJfY29ubmVjdGVkJywgZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgbG9nRGVidWcoJ1Jlc3luY2luZyBhZnRlciBuZXR3b3JrIGxvc3MgdG8gJyArIHB1YmxpY2F0aW9uKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIG5vdGUgdGhlIGJhY2tlbmQgbWlnaHQgcmV0dXJuIGEgbmV3IHN1YnNjcmlwdGlvbiBpZiB0aGUgY2xpZW50IHRvb2sgdG9vIG11Y2ggdGltZSB0byByZWNvbm5lY3QuXG4gICAgICAgICAgICAgICAgICAgICAgICByZWdpc3RlclN1YnNjcmlwdGlvbigpO1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9LCBsaXN0ZW5Ob3cgPyAwIDogMjAwMCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIHJlZ2lzdGVyU3Vic2NyaXB0aW9uKCkge1xuICAgICAgICAgICAgICAgICRzb2NrZXRpby5mZXRjaCgnc3luYy5zdWJzY3JpYmUnLCB7XG4gICAgICAgICAgICAgICAgICAgIHZlcnNpb246IFNZTkNfVkVSU0lPTixcbiAgICAgICAgICAgICAgICAgICAgaWQ6IHN1YnNjcmlwdGlvbklkLCAvLyB0byB0cnkgdG8gcmUtdXNlIGV4aXN0aW5nIHN1YmNyaXB0aW9uXG4gICAgICAgICAgICAgICAgICAgIHB1YmxpY2F0aW9uOiBwdWJsaWNhdGlvbixcbiAgICAgICAgICAgICAgICAgICAgcGFyYW1zOiBzdWJQYXJhbXNcbiAgICAgICAgICAgICAgICB9KS50aGVuKGZ1bmN0aW9uIChzdWJJZCkge1xuICAgICAgICAgICAgICAgICAgICBzdWJzY3JpcHRpb25JZCA9IHN1YklkO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiB1bnJlZ2lzdGVyU3Vic2NyaXB0aW9uKCkge1xuICAgICAgICAgICAgICAgIGlmIChzdWJzY3JpcHRpb25JZCkge1xuICAgICAgICAgICAgICAgICAgICAkc29ja2V0aW8uZmV0Y2goJ3N5bmMudW5zdWJzY3JpYmUnLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICB2ZXJzaW9uOiBTWU5DX1ZFUlNJT04sXG4gICAgICAgICAgICAgICAgICAgICAgICBpZDogc3Vic2NyaXB0aW9uSWRcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIHN1YnNjcmlwdGlvbklkID0gbnVsbDtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIGxpc3RlblRvUHVibGljYXRpb24oKSB7XG4gICAgICAgICAgICAgICAgLy8gY2Fubm90IG9ubHkgbGlzdGVuIHRvIHN1YnNjcmlwdGlvbklkIHlldC4uLmJlY2F1c2UgdGhlIHJlZ2lzdHJhdGlvbiBtaWdodCBoYXZlIGFuc3dlciBwcm92aWRlZCBpdHMgaWQgeWV0Li4uYnV0IHN0YXJ0ZWQgYnJvYWRjYXN0aW5nIGNoYW5nZXMuLi5AVE9ETyBjYW4gYmUgaW1wcm92ZWQuLi5cbiAgICAgICAgICAgICAgICBwdWJsaWNhdGlvbkxpc3RlbmVyT2ZmID0gYWRkUHVibGljYXRpb25MaXN0ZW5lcihwdWJsaWNhdGlvbiwgZnVuY3Rpb24gKGJhdGNoKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChzdWJzY3JpcHRpb25JZCA9PT0gYmF0Y2guc3Vic2NyaXB0aW9uSWQgfHwgKCFzdWJzY3JpcHRpb25JZCAmJiBjaGVja0RhdGFTZXRQYXJhbXNJZk1hdGNoaW5nQmF0Y2hQYXJhbXMoYmF0Y2gucGFyYW1zKSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghYmF0Y2guZGlmZikge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vIENsZWFyIHRoZSBjYWNoZSB0byByZWJ1aWxkIGl0IGlmIGFsbCBkYXRhIHdhcyByZWNlaXZlZC5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWNvcmRTdGF0ZXMgPSB7fTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWlzU2luZ2xlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhY2hlLmxlbmd0aCA9IDA7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgYXBwbHlDaGFuZ2VzKGJhdGNoLnJlY29yZHMpO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFpc0luaXRpYWxQdXNoQ29tcGxldGVkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaXNJbml0aWFsUHVzaENvbXBsZXRlZCA9IHRydWU7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZGVmZXJyZWRJbml0aWFsaXphdGlvbi5yZXNvbHZlKGdldERhdGEoKSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAqIGlmIHRoZSBwYXJhbXMgb2YgdGhlIGRhdGFzZXQgbWF0Y2hlcyB0aGUgbm90aWZpY2F0aW9uLCBpdCBtZWFucyB0aGUgZGF0YSBuZWVkcyB0byBiZSBjb2xsZWN0IHRvIHVwZGF0ZSBhcnJheS5cbiAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBjaGVja0RhdGFTZXRQYXJhbXNJZk1hdGNoaW5nQmF0Y2hQYXJhbXMoYmF0Y2hQYXJhbXMpIHtcbiAgICAgICAgICAgICAgICAvLyBpZiAocGFyYW1zLmxlbmd0aCAhPSBzdHJlYW1QYXJhbXMubGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgLy8gICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgICAgICAvLyB9XG4gICAgICAgICAgICAgICAgaWYgKCFzdWJQYXJhbXMgfHwgT2JqZWN0LmtleXMoc3ViUGFyYW1zKS5sZW5ndGggPT0gMCkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB2YXIgbWF0Y2hpbmcgPSB0cnVlO1xuICAgICAgICAgICAgICAgIGZvciAodmFyIHBhcmFtIGluIGJhdGNoUGFyYW1zKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIGFyZSBvdGhlciBwYXJhbXMgbWF0Y2hpbmc/XG4gICAgICAgICAgICAgICAgICAgIC8vIGV4OiB3ZSBtaWdodCBoYXZlIHJlY2VpdmUgYSBub3RpZmljYXRpb24gYWJvdXQgdGFza0lkPTIwIGJ1dCB0aGlzIHN1YnNjcmlwdGlvbiBhcmUgb25seSBpbnRlcmVzdGVkIGFib3V0IHRhc2tJZC0zXG4gICAgICAgICAgICAgICAgICAgIGlmIChiYXRjaFBhcmFtc1twYXJhbV0gIT09IHN1YlBhcmFtc1twYXJhbV0pIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIG1hdGNoaW5nID0gZmFsc2U7XG4gICAgICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICByZXR1cm4gbWF0Y2hpbmc7XG5cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy8gZmV0Y2ggYWxsIHRoZSBtaXNzaW5nIHJlY29yZHMsIGFuZCBhY3RpdmF0ZSB0aGUgY2FsbCBiYWNrcyAoYWRkLHVwZGF0ZSxyZW1vdmUpIGFjY29yZGluZ2x5IGlmIHRoZXJlIGlzIHNvbWV0aGluZyB0aGF0IGlzIG5ldyBvciBub3QgYWxyZWFkeSBpbiBzeW5jLlxuICAgICAgICAgICAgZnVuY3Rpb24gYXBwbHlDaGFuZ2VzKHJlY29yZHMpIHtcbiAgICAgICAgICAgICAgICB2YXIgbmV3RGF0YUFycmF5ID0gW107XG4gICAgICAgICAgICAgICAgdmFyIG5ld0RhdGE7XG4gICAgICAgICAgICAgICAgc0RzLnJlYWR5ID0gZmFsc2U7XG4gICAgICAgICAgICAgICAgcmVjb3Jkcy5mb3JFYWNoKGZ1bmN0aW9uIChyZWNvcmQpIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gICAgICAgICAgICAgICAgICAgbG9nSW5mbygnRGF0YXN5bmMgWycgKyBkYXRhU3RyZWFtTmFtZSArICddIHJlY2VpdmVkOicgK0pTT04uc3RyaW5naWZ5KHJlY29yZCkpOy8vKyByZWNvcmQuaWQpO1xuICAgICAgICAgICAgICAgICAgICBpZiAocmVjb3JkLnJlbW92ZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgcmVtb3ZlUmVjb3JkKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAocmVjb3JkU3RhdGVzW3JlY29yZC5pZF0pIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIGlmIHRoZSByZWNvcmQgaXMgYWxyZWFkeSBwcmVzZW50IGluIHRoZSBjYWNoZS4uLnNvIGl0IGlzIG1pZ2h0YmUgYW4gdXBkYXRlLi5cbiAgICAgICAgICAgICAgICAgICAgICAgIG5ld0RhdGEgPSB1cGRhdGVSZWNvcmQocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIG5ld0RhdGEgPSBhZGRSZWNvcmQocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBpZiAobmV3RGF0YSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgbmV3RGF0YUFycmF5LnB1c2gobmV3RGF0YSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICBzRHMucmVhZHkgPSB0cnVlO1xuICAgICAgICAgICAgICAgIGlmIChpc1NpbmdsZSkge1xuICAgICAgICAgICAgICAgICAgICBzeW5jTGlzdGVuZXIubm90aWZ5KCdyZWFkeScsIGdldERhdGEoKSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3luY0xpc3RlbmVyLm5vdGlmeSgncmVhZHknLCBnZXREYXRhKCksIG5ld0RhdGFBcnJheSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqIEFsdGhvdWdoIG1vc3QgY2FzZXMgYXJlIGhhbmRsZWQgdXNpbmcgb25SZWFkeSwgdGhpcyB0ZWxscyB5b3UgdGhlIGN1cnJlbnQgZGF0YSBzdGF0ZS5cbiAgICAgICAgICAgICAqIFxuICAgICAgICAgICAgICogQHJldHVybnMgaWYgdHJ1ZSBpcyBhIHN5bmMgaGFzIGJlZW4gcHJvY2Vzc2VkIG90aGVyd2lzZSBmYWxzZSBpZiB0aGUgZGF0YSBpcyBub3QgcmVhZHkuXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIGlzUmVhZHkoKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMucmVhZHk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqIFxuICAgICAgICAgICAgICogcmV0dXJucyBhIGZ1bmN0aW9uIHRvIHJlbW92ZSB0aGUgbGlzdGVuZXIuXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIG9uQWRkKGNhbGxiYWNrKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHN5bmNMaXN0ZW5lci5vbignYWRkJywgY2FsbGJhY2spO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqIFxuICAgICAgICAgICAgICogcmV0dXJucyBhIGZ1bmN0aW9uIHRvIHJlbW92ZSB0aGUgbGlzdGVuZXIuXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIG9uVXBkYXRlKGNhbGxiYWNrKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHN5bmNMaXN0ZW5lci5vbigndXBkYXRlJywgY2FsbGJhY2spO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqIFxuICAgICAgICAgICAgICogcmV0dXJucyBhIGZ1bmN0aW9uIHRvIHJlbW92ZSB0aGUgbGlzdGVuZXIuXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIG9uUmVtb3ZlKGNhbGxiYWNrKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHN5bmNMaXN0ZW5lci5vbigncmVtb3ZlJywgY2FsbGJhY2spO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqIFxuICAgICAgICAgICAgICogcmV0dXJucyBhIGZ1bmN0aW9uIHRvIHJlbW92ZSB0aGUgbGlzdGVuZXIuXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIG9uUmVhZHkoY2FsbGJhY2spIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gc3luY0xpc3RlbmVyLm9uKCdyZWFkeScsIGNhbGxiYWNrKTtcbiAgICAgICAgICAgIH1cblxuXG4gICAgICAgICAgICBmdW5jdGlvbiBhZGRSZWNvcmQocmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgbG9nRGVidWcoJ1N5bmMgLT4gSW5zZXJ0ZWQgTmV3IHJlY29yZCAjJyArIHJlY29yZC5pZCArICcgZm9yIHN1YnNjcmlwdGlvbiB0byAnICsgcHVibGljYXRpb24pOy8vIEpTT04uc3RyaW5naWZ5KHJlY29yZCkpO1xuICAgICAgICAgICAgICAgIGdldFJldmlzaW9uKHJlY29yZCk7IC8vIGp1c3QgbWFrZSBzdXJlIHdlIGNhbiBnZXQgYSByZXZpc2lvbiBiZWZvcmUgd2UgaGFuZGxlIHRoaXMgcmVjb3JkXG4gICAgICAgICAgICAgICAgdXBkYXRlRGF0YVN0b3JhZ2UoZm9ybWF0UmVjb3JkID8gZm9ybWF0UmVjb3JkKHJlY29yZCkgOiByZWNvcmQpO1xuICAgICAgICAgICAgICAgIHN5bmNMaXN0ZW5lci5ub3RpZnkoJ2FkZCcsIHJlY29yZCk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlY29yZDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gdXBkYXRlUmVjb3JkKHJlY29yZCkge1xuICAgICAgICAgICAgICAgIHZhciBwcmV2aW91cyA9IHJlY29yZFN0YXRlc1tyZWNvcmQuaWRdO1xuICAgICAgICAgICAgICAgIGlmIChnZXRSZXZpc2lvbihyZWNvcmQpIDw9IGdldFJldmlzaW9uKHByZXZpb3VzKSkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgbG9nRGVidWcoJ1N5bmMgLT4gVXBkYXRlZCByZWNvcmQgIycgKyByZWNvcmQuaWQgKyAnIGZvciBzdWJzY3JpcHRpb24gdG8gJyArIHB1YmxpY2F0aW9uKTsvLyBKU09OLnN0cmluZ2lmeShyZWNvcmQpKTtcbiAgICAgICAgICAgICAgICB1cGRhdGVEYXRhU3RvcmFnZShmb3JtYXRSZWNvcmQgPyBmb3JtYXRSZWNvcmQocmVjb3JkKSA6IHJlY29yZCk7XG4gICAgICAgICAgICAgICAgc3luY0xpc3RlbmVyLm5vdGlmeSgndXBkYXRlJywgcmVjb3JkKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gcmVjb3JkO1xuICAgICAgICAgICAgfVxuXG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIHJlbW92ZVJlY29yZChyZWNvcmQpIHtcbiAgICAgICAgICAgICAgICB2YXIgcHJldmlvdXMgPSByZWNvcmRTdGF0ZXNbcmVjb3JkLmlkXTtcbiAgICAgICAgICAgICAgICBpZiAoIXByZXZpb3VzIHx8IGdldFJldmlzaW9uKHJlY29yZCkgPiBnZXRSZXZpc2lvbihwcmV2aW91cykpIHtcbiAgICAgICAgICAgICAgICAgICAgbG9nRGVidWcoJ1N5bmMgLT4gUmVtb3ZlZCAjJyArIHJlY29yZC5pZCArICcgZm9yIHN1YnNjcmlwdGlvbiB0byAnICsgcHVibGljYXRpb24pO1xuICAgICAgICAgICAgICAgICAgICAvLyBXZSBjb3VsZCBoYXZlIGZvciB0aGUgc2FtZSByZWNvcmQgY29uc2VjdXRpdmVseSBmZXRjaGluZyBpbiB0aGlzIG9yZGVyOlxuICAgICAgICAgICAgICAgICAgICAvLyBkZWxldGUgaWQ6NCwgcmV2IDEwLCB0aGVuIGFkZCBpZDo0LCByZXYgOS4uLi4gYnkga2VlcGluZyB0cmFjayBvZiB3aGF0IHdhcyBkZWxldGVkLCB3ZSB3aWxsIG5vdCBhZGQgdGhlIHJlY29yZCBzaW5jZSBpdCB3YXMgZGVsZXRlZCB3aXRoIGEgbW9zdCByZWNlbnQgdGltZXN0YW1wLlxuICAgICAgICAgICAgICAgICAgICByZWNvcmQucmVtb3ZlZCA9IHRydWU7IC8vIFNvIHdlIG9ubHkgZmxhZyBhcyByZW1vdmVkLCBsYXRlciBvbiB0aGUgZ2FyYmFnZSBjb2xsZWN0b3Igd2lsbCBnZXQgcmlkIG9mIGl0LiAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICB1cGRhdGVEYXRhU3RvcmFnZShyZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICAvLyBpZiB0aGVyZSBpcyBubyBwcmV2aW91cyByZWNvcmQgd2UgZG8gbm90IG5lZWQgdG8gcmVtb3ZlZCBhbnkgdGhpbmcgZnJvbSBvdXIgc3RvcmFnZS4gICAgIFxuICAgICAgICAgICAgICAgICAgICBpZiAocHJldmlvdXMpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHN5bmNMaXN0ZW5lci5ub3RpZnkoJ3JlbW92ZScsIHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgICAgICBkaXNwb3NlKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBmdW5jdGlvbiBkaXNwb3NlKHJlY29yZCkge1xuICAgICAgICAgICAgICAgICRzeW5jR2FyYmFnZUNvbGxlY3Rvci5kaXNwb3NlKGZ1bmN0aW9uIGNvbGxlY3QoKSB7XG4gICAgICAgICAgICAgICAgICAgIHZhciBleGlzdGluZ1JlY29yZCA9IHJlY29yZFN0YXRlc1tyZWNvcmQuaWRdO1xuICAgICAgICAgICAgICAgICAgICBpZiAoZXhpc3RpbmdSZWNvcmQgJiYgcmVjb3JkLnJldmlzaW9uID49IGV4aXN0aW5nUmVjb3JkLnJldmlzaW9uXG4gICAgICAgICAgICAgICAgICAgICkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy9sb2dEZWJ1ZygnQ29sbGVjdCBOb3c6JyArIEpTT04uc3RyaW5naWZ5KHJlY29yZCkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgZGVsZXRlIHJlY29yZFN0YXRlc1tyZWNvcmQuaWRdO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIGlzRXhpc3RpbmdTdGF0ZUZvcihyZWNvcmRJZCkge1xuICAgICAgICAgICAgICAgIHJldHVybiAhIXJlY29yZFN0YXRlc1tyZWNvcmRJZF07XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIHVwZGF0ZVN5bmNlZE9iamVjdChyZWNvcmQpIHtcbiAgICAgICAgICAgICAgICByZWNvcmRTdGF0ZXNbcmVjb3JkLmlkXSA9IHJlY29yZDtcblxuICAgICAgICAgICAgICAgIGlmICghcmVjb3JkLnJlbW92ZSkge1xuICAgICAgICAgICAgICAgICAgICAkc3luY01lcmdlLm1lcmdlKGNhY2hlLCByZWNvcmQsIHN0cmljdE1vZGUpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICRzeW5jTWVyZ2UuY2xlYXJPYmplY3QoY2FjaGUpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gdXBkYXRlU3luY2VkQXJyYXkocmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgdmFyIGV4aXN0aW5nID0gcmVjb3JkU3RhdGVzW3JlY29yZC5pZF07XG4gICAgICAgICAgICAgICAgaWYgKCFleGlzdGluZykge1xuICAgICAgICAgICAgICAgICAgICAvLyBhZGQgbmV3IGluc3RhbmNlXG4gICAgICAgICAgICAgICAgICAgIHJlY29yZFN0YXRlc1tyZWNvcmQuaWRdID0gcmVjb3JkO1xuICAgICAgICAgICAgICAgICAgICBpZiAoIXJlY29yZC5yZW1vdmVkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjYWNoZS5wdXNoKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAkc3luY01lcmdlLm1lcmdlKGV4aXN0aW5nLCByZWNvcmQsIHN0cmljdE1vZGUpO1xuICAgICAgICAgICAgICAgICAgICBpZiAocmVjb3JkLnJlbW92ZWQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNhY2hlLnNwbGljZShjYWNoZS5pbmRleE9mKGV4aXN0aW5nKSwgMSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cblxuXG5cblxuICAgICAgICAgICAgZnVuY3Rpb24gZ2V0UmV2aXNpb24ocmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgLy8gd2hhdCByZXNlcnZlZCBmaWVsZCBkbyB3ZSB1c2UgYXMgdGltZXN0YW1wXG4gICAgICAgICAgICAgICAgaWYgKGFuZ3VsYXIuaXNEZWZpbmVkKHJlY29yZC5yZXZpc2lvbikpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHJlY29yZC5yZXZpc2lvbjtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgaWYgKGFuZ3VsYXIuaXNEZWZpbmVkKHJlY29yZC50aW1lc3RhbXApKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiByZWNvcmQudGltZXN0YW1wO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1N5bmMgcmVxdWlyZXMgYSByZXZpc2lvbiBvciB0aW1lc3RhbXAgcHJvcGVydHkgaW4gcmVjZWl2ZWQgJyArIChvYmplY3RDbGFzcyA/ICdvYmplY3QgWycgKyBvYmplY3RDbGFzcy5uYW1lICsgJ10nIDogJ3JlY29yZCcpKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiB0aGlzIG9iamVjdCBcbiAgICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIFN5bmNMaXN0ZW5lcigpIHtcbiAgICAgICAgICAgIHZhciBldmVudHMgPSB7fTtcbiAgICAgICAgICAgIHZhciBjb3VudCA9IDA7XG5cbiAgICAgICAgICAgIHRoaXMubm90aWZ5ID0gbm90aWZ5O1xuICAgICAgICAgICAgdGhpcy5vbiA9IG9uO1xuXG4gICAgICAgICAgICBmdW5jdGlvbiBub3RpZnkoZXZlbnQsIGRhdGExLCBkYXRhMikge1xuICAgICAgICAgICAgICAgIHZhciBsaXN0ZW5lcnMgPSBldmVudHNbZXZlbnRdO1xuICAgICAgICAgICAgICAgIGlmIChsaXN0ZW5lcnMpIHtcbiAgICAgICAgICAgICAgICAgICAgXy5mb3JFYWNoKGxpc3RlbmVycywgZnVuY3Rpb24gKGNhbGxiYWNrLCBpZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgY2FsbGJhY2soZGF0YTEsIGRhdGEyKTtcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqIEByZXR1cm5zIGhhbmRsZXIgdG8gdW5yZWdpc3RlciBsaXN0ZW5lclxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBvbihldmVudCwgY2FsbGJhY2spIHtcbiAgICAgICAgICAgICAgICB2YXIgbGlzdGVuZXJzID0gZXZlbnRzW2V2ZW50XTtcbiAgICAgICAgICAgICAgICBpZiAoIWxpc3RlbmVycykge1xuICAgICAgICAgICAgICAgICAgICBsaXN0ZW5lcnMgPSBldmVudHNbZXZlbnRdID0ge307XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHZhciBpZCA9IGNvdW50Kys7XG4gICAgICAgICAgICAgICAgbGlzdGVuZXJzW2lkKytdID0gY2FsbGJhY2s7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICAgICAgZGVsZXRlIGxpc3RlbmVyc1tpZF07XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfTtcblxuICAgIGZ1bmN0aW9uIGxvZ0luZm8obXNnKSB7XG4gICAgICAgIGlmIChkZWJ1Zykge1xuICAgICAgICAgICAgY29uc29sZS5kZWJ1ZygnU1lOQyhpbmZvKTogJyArIG1zZyk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBmdW5jdGlvbiBsb2dEZWJ1Zyhtc2cpIHtcbiAgICAgICAgaWYgKGRlYnVnID09IDIpIHtcbiAgICAgICAgICAgIGNvbnNvbGUuZGVidWcoJ1NZTkMoZGVidWcpOiAnICsgbXNnKTtcbiAgICAgICAgfVxuXG4gICAgfVxuXG5cblxufTtcbn0oKSk7XG5cbiIsImFuZ3VsYXJcbiAgICAubW9kdWxlKCdzeW5jJywgWydzb2NrZXRpby1hdXRoJ10pXG4gICAgLmNvbmZpZyhmdW5jdGlvbigkc29ja2V0aW9Qcm92aWRlcil7XG4gICAgICAgICRzb2NrZXRpb1Byb3ZpZGVyLnNldERlYnVnKHRydWUpO1xuICAgIH0pO1xuIiwiYW5ndWxhclxuICAgIC5tb2R1bGUoJ3N5bmMnKVxuICAgIC5mYWN0b3J5KCckc3luY0dhcmJhZ2VDb2xsZWN0b3InLCBzeW5jR2FyYmFnZUNvbGxlY3Rvcik7XG5cbi8qKlxuICogc2FmZWx5IHJlbW92ZSBkZWxldGVkIHJlY29yZC9vYmplY3QgZnJvbSBtZW1vcnkgYWZ0ZXIgdGhlIHN5bmMgcHJvY2VzcyBkaXNwb3NlZCB0aGVtLlxuICogXG4gKiBUT0RPOiBTZWNvbmRzIHNob3VsZCByZWZsZWN0IHRoZSBtYXggdGltZSAgdGhhdCBzeW5jIGNhY2hlIGlzIHZhbGlkIChuZXR3b3JrIGxvc3Mgd291bGQgZm9yY2UgYSByZXN5bmMpLCB3aGljaCBzaG91bGQgbWF0Y2ggbWF4RGlzY29ubmVjdGlvblRpbWVCZWZvcmVEcm9wcGluZ1N1YnNjcmlwdGlvbiBvbiB0aGUgc2VydmVyIHNpZGUuXG4gKiBcbiAqIE5vdGU6XG4gKiByZW1vdmVkIHJlY29yZCBzaG91bGQgYmUgZGVsZXRlZCBmcm9tIHRoZSBzeW5jIGludGVybmFsIGNhY2hlIGFmdGVyIGEgd2hpbGUgc28gdGhhdCB0aGV5IGRvIG5vdCBzdGF5IGluIHRoZSBtZW1vcnkuIFRoZXkgY2Fubm90IGJlIHJlbW92ZWQgdG9vIGVhcmx5IGFzIGFuIG9sZGVyIHZlcnNpb24vc3RhbXAgb2YgdGhlIHJlY29yZCBjb3VsZCBiZSByZWNlaXZlZCBhZnRlciBpdHMgcmVtb3ZhbC4uLndoaWNoIHdvdWxkIHJlLWFkZCB0byBjYWNoZS4uLmR1ZSBhc3luY2hyb25vdXMgcHJvY2Vzc2luZy4uLlxuICovXG5mdW5jdGlvbiBzeW5jR2FyYmFnZUNvbGxlY3RvcigpIHtcbiAgICB2YXIgaXRlbXMgPSBbXTtcbiAgICB2YXIgc2Vjb25kcyA9IDI7XG4gICAgdmFyIHNjaGVkdWxlZCA9IGZhbHNlO1xuXG4gICAgdmFyIHNlcnZpY2UgPSB7XG4gICAgICAgIHNldFNlY29uZHM6IHNldFNlY29uZHMsXG4gICAgICAgIGdldFNlY29uZHM6IGdldFNlY29uZHMsXG4gICAgICAgIGRpc3Bvc2U6IGRpc3Bvc2UsXG4gICAgICAgIHNjaGVkdWxlOiBzY2hlZHVsZSxcbiAgICAgICAgcnVuOiBydW4sXG4gICAgICAgIGdldEl0ZW1Db3VudDogZ2V0SXRlbUNvdW50XG4gICAgfTtcblxuICAgIHJldHVybiBzZXJ2aWNlO1xuXG4gICAgLy8vLy8vLy8vL1xuXG4gICAgZnVuY3Rpb24gc2V0U2Vjb25kcyh2YWx1ZSkge1xuICAgICAgICBzZWNvbmRzID0gdmFsdWU7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gZ2V0U2Vjb25kcygpIHtcbiAgICAgICAgcmV0dXJuIHNlY29uZHM7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gZ2V0SXRlbUNvdW50KCkge1xuICAgICAgICByZXR1cm4gaXRlbXMubGVuZ3RoO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIGRpc3Bvc2UoY29sbGVjdCkge1xuICAgICAgICBpdGVtcy5wdXNoKHtcbiAgICAgICAgICAgIHRpbWVzdGFtcDogRGF0ZS5ub3coKSxcbiAgICAgICAgICAgIGNvbGxlY3Q6IGNvbGxlY3RcbiAgICAgICAgfSk7XG4gICAgICAgIGlmICghc2NoZWR1bGVkKSB7XG4gICAgICAgICAgICBzZXJ2aWNlLnNjaGVkdWxlKCk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBmdW5jdGlvbiBzY2hlZHVsZSgpIHtcbiAgICAgICAgaWYgKCFzZWNvbmRzKSB7XG4gICAgICAgICAgICBzZXJ2aWNlLnJ1bigpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIHNjaGVkdWxlZCA9IHRydWU7XG4gICAgICAgIHNldFRpbWVvdXQoZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgc2VydmljZS5ydW4oKTtcbiAgICAgICAgICAgIGlmIChpdGVtcy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICAgICAgc2NoZWR1bGUoKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgc2NoZWR1bGVkID0gZmFsc2U7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0sIHNlY29uZHMgKiAxMDAwKTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBydW4oKSB7XG4gICAgICAgIHZhciB0aW1lb3V0ID0gRGF0ZS5ub3coKSAtIHNlY29uZHMgKiAxMDAwO1xuICAgICAgICB3aGlsZSAoaXRlbXMubGVuZ3RoID4gMCAmJiBpdGVtc1swXS50aW1lc3RhbXAgPD0gdGltZW91dCkge1xuICAgICAgICAgICAgaXRlbXMuc2hpZnQoKS5jb2xsZWN0KCk7XG4gICAgICAgIH1cbiAgICB9XG59XG5cblxuIiwiXG5hbmd1bGFyXG4gICAgLm1vZHVsZSgnc3luYycpXG4gICAgLmZhY3RvcnkoJyRzeW5jTWVyZ2UnLCBzeW5jTWVyZ2UpO1xuXG5mdW5jdGlvbiBzeW5jTWVyZ2UoKSB7XG5cbiAgICByZXR1cm4ge1xuICAgICAgICBtZXJnZTogbWVyZ2VPYmplY3QsXG4gICAgICAgIGNsZWFyT2JqZWN0OiBjbGVhck9iamVjdFxuICAgIH1cblxuXG4gICAgLyoqIG1lcmdlIGFuIG9iamVjdCB3aXRoIGFuIG90aGVyLiBNZXJnZSBhbHNvIGlubmVyIG9iamVjdHMgYW5kIG9iamVjdHMgaW4gYXJyYXkuIFxuICAgICAqIFJlZmVyZW5jZSB0byB0aGUgb3JpZ2luYWwgb2JqZWN0cyBhcmUgbWFpbnRhaW5lZCBpbiB0aGUgZGVzdGluYXRpb24gb2JqZWN0LlxuICAgICAqIE9ubHkgY29udGVudCBpcyB1cGRhdGVkLlxuICAgICAqXG4gICAgICpAcGFyYW0gPG9iamVjdD4gZGVzdGluYXRpb24gIG9iamVjdCB0byBtZXJnZSBpbnRvXG4gICAgICpAcGFyYW0gPG9iamVjdD4gZGVzdGluYXRpb24gIG9iamVjdCB0byBtZXJnZSBpbnRvXG4gICAgICpAcGFyYW0gPGJvb2xlYW4+IGlzU3RyaWN0TW9kZSBkZWZhdWx0IGZhbHNlLCBpZiB0cnVlIHdvdWxkIGdlbmVyYXRlIGFuIGVycm9yIGlmIGlubmVyIG9iamVjdHMgaW4gYXJyYXkgZG8gbm90IGhhdmUgaWQgZmllbGRcbiAgICAgKi9cbiAgICBmdW5jdGlvbiBtZXJnZU9iamVjdChkZXN0aW5hdGlvbiwgc291cmNlLCBpc1N0cmljdE1vZGUpIHtcbiAgICAgICAgaWYgKCFkZXN0aW5hdGlvbikge1xuICAgICAgICAgICAgcmV0dXJuIHNvdXJjZTsvLyBfLmFzc2lnbih7fSwgc291cmNlKTs7XG4gICAgICAgIH1cbiAgICAgICAgLy8gY3JlYXRlIG5ldyBvYmplY3QgY29udGFpbmluZyBvbmx5IHRoZSBwcm9wZXJ0aWVzIG9mIHNvdXJjZSBtZXJnZSB3aXRoIGRlc3RpbmF0aW9uXG4gICAgICAgIHZhciBvYmplY3QgPSB7fTtcbiAgICAgICAgZm9yICh2YXIgcHJvcGVydHkgaW4gc291cmNlKSB7XG4gICAgICAgICAgICBpZiAoXy5pc0FycmF5KHNvdXJjZVtwcm9wZXJ0eV0pKSB7XG4gICAgICAgICAgICAgICAgb2JqZWN0W3Byb3BlcnR5XSA9IG1lcmdlQXJyYXkoZGVzdGluYXRpb25bcHJvcGVydHldLCBzb3VyY2VbcHJvcGVydHldLCBpc1N0cmljdE1vZGUpO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChfLmlzRnVuY3Rpb24oc291cmNlW3Byb3BlcnR5XSkpIHtcbiAgICAgICAgICAgICAgICBvYmplY3RbcHJvcGVydHldID0gc291cmNlW3Byb3BlcnR5XTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoXy5pc09iamVjdChzb3VyY2VbcHJvcGVydHldKSkge1xuICAgICAgICAgICAgICAgIG9iamVjdFtwcm9wZXJ0eV0gPSBtZXJnZU9iamVjdChkZXN0aW5hdGlvbltwcm9wZXJ0eV0sIHNvdXJjZVtwcm9wZXJ0eV0sIGlzU3RyaWN0TW9kZSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIG9iamVjdFtwcm9wZXJ0eV0gPSBzb3VyY2VbcHJvcGVydHldO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgY2xlYXJPYmplY3QoZGVzdGluYXRpb24pO1xuICAgICAgICBfLmFzc2lnbihkZXN0aW5hdGlvbiwgb2JqZWN0KTtcblxuICAgICAgICByZXR1cm4gZGVzdGluYXRpb247XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gbWVyZ2VBcnJheShkZXN0aW5hdGlvbiwgc291cmNlLCBpc1N0cmljdE1vZGUpIHtcbiAgICAgICAgaWYgKCFkZXN0aW5hdGlvbikge1xuICAgICAgICAgICAgcmV0dXJuIHNvdXJjZTtcbiAgICAgICAgfVxuICAgICAgICB2YXIgYXJyYXkgPSBbXTtcbiAgICAgICAgc291cmNlLmZvckVhY2goZnVuY3Rpb24gKGl0ZW0pIHtcbiAgICAgICAgICAgIGlmICghaXNTdHJpY3RNb2RlKSB7XG4gICAgICAgICAgICAgICAgYXJyYXkucHVzaChpdGVtKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgLy8gUVVJQ0sgRklYOiBJIGhhZCB0byByZW1vdmUgdGhpcyBjb2RlLi4uLiBzaW5jZSBzdXJ2ZXkgZG9lcyBub3Qgd29yay4uLlxuICAgICAgICAgICAgICAgIC8vXG4gICAgICAgICAgICAgICAgLy8gb2JqZWN0IGluIGFycmF5IG11c3QgaGF2ZSBhbiBpZCBvdGhlcndpc2Ugd2UgY2FuJ3QgbWFpbnRhaW4gdGhlIGluc3RhbmNlIHJlZmVyZW5jZVxuICAgICAgICAgICAgICAgIGlmICghXy5pc0FycmF5KGl0ZW0pICYmIF8uaXNPYmplY3QoaXRlbSkpIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gbGV0IHRyeSB0byBmaW5kIHRoZSBpbnN0YW5jZVxuICAgICAgICAgICAgICAgICAgICBpZiAoYW5ndWxhci5pc0RlZmluZWQoaXRlbS5pZCkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGFycmF5LnB1c2gobWVyZ2VPYmplY3QoXy5maW5kKGRlc3RpbmF0aW9uLCB7IGlkOiBpdGVtLmlkIH0pLCBpdGVtLCBpc1N0cmljdE1vZGUpKTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChpc1N0cmljdE1vZGUpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ29iamVjdHMgaW4gYXJyYXkgbXVzdCBoYXZlIGFuIGlkIG90aGVyd2lzZSB3ZSBjYW5cXCd0IG1haW50YWluIHRoZSBpbnN0YW5jZSByZWZlcmVuY2UuICcgKyBKU09OLnN0cmluZ2lmeShpdGVtKSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICBhcnJheS5wdXNoKGl0ZW0pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgYXJyYXkucHVzaChpdGVtKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH0pO1xuXG4gICAgICAgIGRlc3RpbmF0aW9uLmxlbmd0aCA9IDA7XG4gICAgICAgIEFycmF5LnByb3RvdHlwZS5wdXNoLmFwcGx5KGRlc3RpbmF0aW9uLCBhcnJheSk7XG4gICAgICAgIC8vYW5ndWxhci5jb3B5KGRlc3RpbmF0aW9uLCBhcnJheSk7XG4gICAgICAgIHJldHVybiBkZXN0aW5hdGlvbjtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBjbGVhck9iamVjdChvYmplY3QpIHtcbiAgICAgICAgT2JqZWN0LmtleXMob2JqZWN0KS5mb3JFYWNoKGZ1bmN0aW9uIChrZXkpIHsgZGVsZXRlIG9iamVjdFtrZXldOyB9KTtcbiAgICB9XG59O1xuXG4iLCJcbi8qKlxuICogXG4gKiBTZXJ2aWNlIHRoYXQgYWxsb3dzIGFuIGFycmF5IG9mIGRhdGEgcmVtYWluIGluIHN5bmMgd2l0aCBiYWNrZW5kLlxuICogXG4gKiBcbiAqIGV4OlxuICogd2hlbiB0aGVyZSBpcyBhIG5vdGlmaWNhdGlvbiwgbm90aWNhdGlvblNlcnZpY2Ugbm90aWZpZXMgdGhhdCB0aGVyZSBpcyBzb21ldGhpbmcgbmV3Li4udGhlbiB0aGUgZGF0YXNldCBnZXQgdGhlIGRhdGEgYW5kIG5vdGlmaWVzIGFsbCBpdHMgY2FsbGJhY2suXG4gKiBcbiAqIE5PVEU6IFxuICogIFxuICogXG4gKiBQcmUtUmVxdWlzdGU6XG4gKiAtLS0tLS0tLS0tLS0tXG4gKiBTeW5jIGRvZXMgbm90IHdvcmsgaWYgb2JqZWN0cyBkbyBub3QgaGF2ZSBCT1RIIGlkIGFuZCByZXZpc2lvbiBmaWVsZCEhISFcbiAqIFxuICogV2hlbiB0aGUgYmFja2VuZCB3cml0ZXMgYW55IGRhdGEgdG8gdGhlIGRiIHRoYXQgYXJlIHN1cHBvc2VkIHRvIGJlIHN5bmNyb25pemVkOlxuICogSXQgbXVzdCBtYWtlIHN1cmUgZWFjaCBhZGQsIHVwZGF0ZSwgcmVtb3ZhbCBvZiByZWNvcmQgaXMgdGltZXN0YW1wZWQuXG4gKiBJdCBtdXN0IG5vdGlmeSB0aGUgZGF0YXN0cmVhbSAod2l0aCBub3RpZnlDaGFuZ2Ugb3Igbm90aWZ5UmVtb3ZhbCkgd2l0aCBzb21lIHBhcmFtcyBzbyB0aGF0IGJhY2tlbmQga25vd3MgdGhhdCBpdCBoYXMgdG8gcHVzaCBiYWNrIHRoZSBkYXRhIGJhY2sgdG8gdGhlIHN1YnNjcmliZXJzIChleDogdGhlIHRhc2tDcmVhdGlvbiB3b3VsZCBub3RpZnkgd2l0aCBpdHMgcGxhbklkKVxuKiBcbiAqIFxuICovXG5hbmd1bGFyXG4gICAgLm1vZHVsZSgnc3luYycpXG4gICAgLnByb3ZpZGVyKCckc3luYycsIHN5bmNQcm92aWRlcik7XG5cbmZ1bmN0aW9uIHN5bmNQcm92aWRlcigpIHtcblxuICAgIHZhciBkZWJ1ZztcblxuICAgIHRoaXMuc2V0RGVidWcgPSBmdW5jdGlvbiAodmFsdWUpIHtcbiAgICAgICAgZGVidWcgPSB2YWx1ZTtcbiAgICB9O1xuXG4gICAgdGhpcy4kZ2V0ID0gZnVuY3Rpb24gc3luYygkcm9vdFNjb3BlLCAkcSwgJHNvY2tldGlvLCAkc3luY0dhcmJhZ2VDb2xsZWN0b3IsICRzeW5jTWVyZ2UpIHtcblxuICAgICAgICB2YXIgcHVibGljYXRpb25MaXN0ZW5lcnMgPSB7fSxcbiAgICAgICAgICAgIHB1YmxpY2F0aW9uTGlzdGVuZXJDb3VudCA9IDA7XG4gICAgICAgIHZhciBHUkFDRV9QRVJJT0RfSU5fU0VDT05EUyA9IDg7XG4gICAgICAgIHZhciBTWU5DX1ZFUlNJT04gPSAnMS4xJztcblxuXG4gICAgICAgIGxpc3RlblRvU3luY05vdGlmaWNhdGlvbigpO1xuXG4gICAgICAgIHZhciBzZXJ2aWNlID0ge1xuICAgICAgICAgICAgc3Vic2NyaWJlOiBzdWJzY3JpYmUsXG4gICAgICAgICAgICByZXNvbHZlU3Vic2NyaXB0aW9uOiByZXNvbHZlU3Vic2NyaXB0aW9uLFxuICAgICAgICAgICAgZ2V0R3JhY2VQZXJpb2Q6IGdldEdyYWNlUGVyaW9kXG4gICAgICAgIH07XG5cbiAgICAgICAgcmV0dXJuIHNlcnZpY2U7XG5cbiAgICAgICAgLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy9cbiAgICAgICAgLyoqXG4gICAgICAgICAqIHN1YnNjcmliZSB0byBwdWJsaWNhdGlvbiBhbmQgcmV0dXJucyB0aGUgc3Vic2NyaXB0aW9uIHdoZW4gZGF0YSBpcyBhdmFpbGFibGUuIFxuICAgICAgICAgKiBAcGFyYW0gcHVibGljYXRpb24gbmFtZS4gb24gdGhlIHNlcnZlciBzaWRlLCBhIHB1YmxpY2F0aW9uIHNoYWxsIGV4aXN0LiBleDogbWFnYXppbmVzLnN5bmNcbiAgICAgICAgICogQHBhcmFtIHBhcmFtcyAgIHRoZSBwYXJhbXMgb2JqZWN0IHBhc3NlZCB0byB0aGUgc3Vic2NyaXB0aW9uLCBleDoge21hZ2F6aW5lSWQ6J2VudHJlcHJlbmV1cid9KVxuICAgICAgICAgKiBAcGFyYW0gb2JqZWN0Q2xhc3MgYW4gaW5zdGFuY2Ugb2YgdGhpcyBjbGFzcyB3aWxsIGJlIGNyZWF0ZWQgZm9yIGVhY2ggcmVjb3JkIHJlY2VpdmVkLlxuICAgICAgICAgKiByZXR1cm5zIGEgcHJvbWlzZSByZXR1cm5pbmcgdGhlIHN1YnNjcmlwdGlvbiB3aGVuIHRoZSBkYXRhIGlzIHN5bmNlZFxuICAgICAgICAgKiBvciByZWplY3RzIGlmIHRoZSBpbml0aWFsIHN5bmMgZmFpbHMgdG8gY29tcGxldGUgaW4gYSBsaW1pdGVkIGFtb3VudCBvZiB0aW1lLiBcbiAgICAgICAgICogXG4gICAgICAgICAqIHRvIGdldCB0aGUgZGF0YSBmcm9tIHRoZSBkYXRhU2V0LCBqdXN0IGRhdGFTZXQuZ2V0RGF0YSgpXG4gICAgICAgICAqL1xuICAgICAgICBmdW5jdGlvbiByZXNvbHZlU3Vic2NyaXB0aW9uKHB1YmxpY2F0aW9uTmFtZSwgcGFyYW1zLCBvYmplY3RDbGFzcykge1xuICAgICAgICAgICAgdmFyIGRlZmVycmVkID0gJHEuZGVmZXIoKTtcbiAgICAgICAgICAgIHZhciBzRHMgPSBzdWJzY3JpYmUocHVibGljYXRpb25OYW1lKS5zZXRPYmplY3RDbGFzcyhvYmplY3RDbGFzcyk7XG5cbiAgICAgICAgICAgIC8vIGdpdmUgYSBsaXR0bGUgdGltZSBmb3Igc3Vic2NyaXB0aW9uIHRvIGZldGNoIHRoZSBkYXRhLi4ub3RoZXJ3aXNlIGdpdmUgdXAgc28gdGhhdCB3ZSBkb24ndCBnZXQgc3R1Y2sgaW4gYSByZXNvbHZlIHdhaXRpbmcgZm9yZXZlci5cbiAgICAgICAgICAgIHZhciBncmFjZVBlcmlvZCA9IHNldFRpbWVvdXQoZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgIGlmICghc0RzLnJlYWR5KSB7XG4gICAgICAgICAgICAgICAgICAgIHNEcy5kZXN0cm95KCk7XG4gICAgICAgICAgICAgICAgICAgIGxvZ0luZm8oJ0F0dGVtcHQgdG8gc3Vic2NyaWJlIHRvIHB1YmxpY2F0aW9uICcgKyBwdWJsaWNhdGlvbk5hbWUgKyAnIGZhaWxlZCcpO1xuICAgICAgICAgICAgICAgICAgICBkZWZlcnJlZC5yZWplY3QoJ1NZTkNfVElNRU9VVCcpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0sIEdSQUNFX1BFUklPRF9JTl9TRUNPTkRTICogMTAwMCk7XG5cbiAgICAgICAgICAgIHNEcy5zZXRQYXJhbWV0ZXJzKHBhcmFtcylcbiAgICAgICAgICAgICAgICAud2FpdEZvckRhdGFSZWFkeSgpXG4gICAgICAgICAgICAgICAgLnRoZW4oZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgICAgICBjbGVhclRpbWVvdXQoZ3JhY2VQZXJpb2QpO1xuICAgICAgICAgICAgICAgICAgICBkZWZlcnJlZC5yZXNvbHZlKHNEcyk7XG4gICAgICAgICAgICAgICAgfSkuY2F0Y2goZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgICAgICBjbGVhclRpbWVvdXQoZ3JhY2VQZXJpb2QpO1xuICAgICAgICAgICAgICAgICAgICBzRHMuZGVzdHJveSgpO1xuICAgICAgICAgICAgICAgICAgICBkZWZlcnJlZC5yZWplY3QoJ0ZhaWxlZCB0byBzdWJzY3JpYmUgdG8gcHVibGljYXRpb24gJyArIHB1YmxpY2F0aW9uTmFtZSArICcgZmFpbGVkJyk7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICByZXR1cm4gZGVmZXJyZWQucHJvbWlzZTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiBcbiAgICAgICAgICogZm9yIHRlc3QgcHVycG9zZXMsIHJldHVybnMgdGhlIHRpbWUgcmVzb2x2ZVN1YnNjcmlwdGlvbiBiZWZvcmUgaXQgdGltZXMgb3V0LlxuICAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gZ2V0R3JhY2VQZXJpb2QoKSB7XG4gICAgICAgICAgICByZXR1cm4gR1JBQ0VfUEVSSU9EX0lOX1NFQ09ORFM7XG4gICAgICAgIH1cbiAgICAgICAgLyoqXG4gICAgICAgICAqIHN1YnNjcmliZSB0byBwdWJsaWNhdGlvbi4gSXQgd2lsbCBub3Qgc3luYyB1bnRpbCB5b3Ugc2V0IHRoZSBwYXJhbXMuXG4gICAgICAgICAqIFxuICAgICAgICAgKiBAcGFyYW0gcHVibGljYXRpb24gbmFtZS4gb24gdGhlIHNlcnZlciBzaWRlLCBhIHB1YmxpY2F0aW9uIHNoYWxsIGV4aXN0LiBleDogbWFnYXppbmVzLnN5bmNcbiAgICAgICAgICogQHBhcmFtIHBhcmFtcyAgIHRoZSBwYXJhbXMgb2JqZWN0IHBhc3NlZCB0byB0aGUgc3Vic2NyaXB0aW9uLCBleDoge21hZ2F6aW5lSWQ6J2VudHJlcHJlbmV1cid9KVxuICAgICAgICAgKiByZXR1cm5zIHN1YnNjcmlwdGlvblxuICAgICAgICAgKiBcbiAgICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIHN1YnNjcmliZShwdWJsaWNhdGlvbk5hbWUsIHNjb3BlKSB7XG4gICAgICAgICAgICByZXR1cm4gbmV3IFN1YnNjcmlwdGlvbihwdWJsaWNhdGlvbk5hbWUsIHNjb3BlKTtcbiAgICAgICAgfVxuXG5cblxuICAgICAgICAvLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vL1xuICAgICAgICAvLyBIRUxQRVJTXG5cbiAgICAgICAgLy8gZXZlcnkgc3luYyBub3RpZmljYXRpb24gY29tZXMgdGhydSB0aGUgc2FtZSBldmVudCB0aGVuIGl0IGlzIGRpc3BhdGNoZXMgdG8gdGhlIHRhcmdldGVkIHN1YnNjcmlwdGlvbnMuXG4gICAgICAgIGZ1bmN0aW9uIGxpc3RlblRvU3luY05vdGlmaWNhdGlvbigpIHtcbiAgICAgICAgICAgICRzb2NrZXRpby5vbignU1lOQ19OT1cnLCBmdW5jdGlvbiAoc3ViTm90aWZpY2F0aW9uLCBmbikge1xuICAgICAgICAgICAgICAgIGxvZ0luZm8oJ1N5bmNpbmcgd2l0aCBzdWJzY3JpcHRpb24gW25hbWU6JyArIHN1Yk5vdGlmaWNhdGlvbi5uYW1lICsgJywgaWQ6JyArIHN1Yk5vdGlmaWNhdGlvbi5zdWJzY3JpcHRpb25JZCArICcgLCBwYXJhbXM6JyArIEpTT04uc3RyaW5naWZ5KHN1Yk5vdGlmaWNhdGlvbi5wYXJhbXMpICsgJ10uIFJlY29yZHM6JyArIHN1Yk5vdGlmaWNhdGlvbi5yZWNvcmRzLmxlbmd0aCArICdbJyArIChzdWJOb3RpZmljYXRpb24uZGlmZiA/ICdEaWZmJyA6ICdBbGwnKSArICddJyk7XG4gICAgICAgICAgICAgICAgdmFyIGxpc3RlbmVycyA9IHB1YmxpY2F0aW9uTGlzdGVuZXJzW3N1Yk5vdGlmaWNhdGlvbi5uYW1lXTtcbiAgICAgICAgICAgICAgICBpZiAobGlzdGVuZXJzKSB7XG4gICAgICAgICAgICAgICAgICAgIGZvciAodmFyIGxpc3RlbmVyIGluIGxpc3RlbmVycykge1xuICAgICAgICAgICAgICAgICAgICAgICAgbGlzdGVuZXJzW2xpc3RlbmVyXShzdWJOb3RpZmljYXRpb24pO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGZuKCdTWU5DRUQnKTsgLy8gbGV0IGtub3cgdGhlIGJhY2tlbmQgdGhlIGNsaWVudCB3YXMgYWJsZSB0byBzeW5jLlxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH07XG5cblxuICAgICAgICAvLyB0aGlzIGFsbG93cyBhIGRhdGFzZXQgdG8gbGlzdGVuIHRvIGFueSBTWU5DX05PVyBldmVudC4uYW5kIGlmIHRoZSBub3RpZmljYXRpb24gaXMgYWJvdXQgaXRzIGRhdGEuXG4gICAgICAgIGZ1bmN0aW9uIGFkZFB1YmxpY2F0aW9uTGlzdGVuZXIoc3RyZWFtTmFtZSwgY2FsbGJhY2spIHtcbiAgICAgICAgICAgIHZhciB1aWQgPSBwdWJsaWNhdGlvbkxpc3RlbmVyQ291bnQrKztcbiAgICAgICAgICAgIHZhciBsaXN0ZW5lcnMgPSBwdWJsaWNhdGlvbkxpc3RlbmVyc1tzdHJlYW1OYW1lXTtcbiAgICAgICAgICAgIGlmICghbGlzdGVuZXJzKSB7XG4gICAgICAgICAgICAgICAgcHVibGljYXRpb25MaXN0ZW5lcnNbc3RyZWFtTmFtZV0gPSBsaXN0ZW5lcnMgPSB7fTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGxpc3RlbmVyc1t1aWRdID0gY2FsbGJhY2s7XG5cbiAgICAgICAgICAgIHJldHVybiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgZGVsZXRlIGxpc3RlbmVyc1t1aWRdO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgICAgICAvLyBTdWJzY3JpcHRpb24gb2JqZWN0XG4gICAgICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgICAgICAvKipcbiAgICAgICAgICogYSBzdWJzY3JpcHRpb24gc3luY2hyb25pemVzIHdpdGggdGhlIGJhY2tlbmQgZm9yIGFueSBiYWNrZW5kIGRhdGEgY2hhbmdlIGFuZCBtYWtlcyB0aGF0IGRhdGEgYXZhaWxhYmxlIHRvIGEgY29udHJvbGxlci5cbiAgICAgICAgICogXG4gICAgICAgICAqICBXaGVuIGNsaWVudCBzdWJzY3JpYmVzIHRvIGFuIHN5bmNyb25pemVkIGFwaSwgYW55IGRhdGEgY2hhbmdlIHRoYXQgaW1wYWN0cyB0aGUgYXBpIHJlc3VsdCBXSUxMIGJlIFBVU0hlZCB0byB0aGUgY2xpZW50LlxuICAgICAgICAgKiBJZiB0aGUgY2xpZW50IGRvZXMgTk9UIHN1YnNjcmliZSBvciBzdG9wIHN1YnNjcmliZSwgaXQgd2lsbCBubyBsb25nZXIgcmVjZWl2ZSB0aGUgUFVTSC4gXG4gICAgICAgICAqICAgIFxuICAgICAgICAgKiBpZiB0aGUgY29ubmVjdGlvbiBpcyBsb3N0IGZvciBhIHNob3J0IHRpbWUgKGR1cmF0aW9uIGRlZmluZWQgb24gc2VydmVyLXNpZGUpLCB0aGUgc2VydmVyIHF1ZXVlcyB0aGUgY2hhbmdlcyBpZiBhbnkuIFxuICAgICAgICAgKiBXaGVuIHRoZSBjb25uZWN0aW9uIHJldHVybnMsIHRoZSBtaXNzaW5nIGRhdGEgYXV0b21hdGljYWxseSAgd2lsbCBiZSBQVVNIZWQgdG8gdGhlIHN1YnNjcmliaW5nIGNsaWVudC5cbiAgICAgICAgICogaWYgdGhlIGNvbm5lY3Rpb24gaXMgbG9zdCBmb3IgYSBsb25nIHRpbWUgKGR1cmF0aW9uIGRlZmluZWQgb24gdGhlIHNlcnZlciksIHRoZSBzZXJ2ZXIgd2lsbCBkZXN0cm95IHRoZSBzdWJzY3JpcHRpb24uIFRvIHNpbXBsaWZ5LCB0aGUgY2xpZW50IHdpbGwgcmVzdWJzY3JpYmUgYXQgaXRzIHJlY29ubmVjdGlvbiBhbmQgZ2V0IGFsbCBkYXRhLlxuICAgICAgICAgKiBcbiAgICAgICAgICogc3Vic2NyaXB0aW9uIG9iamVjdCBwcm92aWRlcyAzIGNhbGxiYWNrcyAoYWRkLHVwZGF0ZSwgZGVsKSB3aGljaCBhcmUgY2FsbGVkIGR1cmluZyBzeW5jaHJvbml6YXRpb24uXG4gICAgICAgICAqICAgICAgXG4gICAgICAgICAqIFNjb3BlIHdpbGwgYWxsb3cgdGhlIHN1YnNjcmlwdGlvbiBzdG9wIHN5bmNocm9uaXppbmcgYW5kIGNhbmNlbCByZWdpc3RyYXRpb24gd2hlbiBpdCBpcyBkZXN0cm95ZWQuIFxuICAgICAgICAgKiAgXG4gICAgICAgICAqIENvbnN0cnVjdG9yOlxuICAgICAgICAgKiBcbiAgICAgICAgICogQHBhcmFtIHB1YmxpY2F0aW9uLCB0aGUgcHVibGljYXRpb24gbXVzdCBleGlzdCBvbiB0aGUgc2VydmVyIHNpZGVcbiAgICAgICAgICogQHBhcmFtIHNjb3BlLCBieSBkZWZhdWx0ICRyb290U2NvcGUsIGJ1dCBjYW4gYmUgbW9kaWZpZWQgbGF0ZXIgb24gd2l0aCBhdHRhY2ggbWV0aG9kLlxuICAgICAgICAgKi9cblxuICAgICAgICBmdW5jdGlvbiBTdWJzY3JpcHRpb24ocHVibGljYXRpb24sIHNjb3BlKSB7XG4gICAgICAgICAgICB2YXIgdGltZXN0YW1wRmllbGQsIGlzU3luY2luZ09uID0gZmFsc2UsIGlzU2luZ2xlLCB1cGRhdGVEYXRhU3RvcmFnZSwgY2FjaGUsIGlzSW5pdGlhbFB1c2hDb21wbGV0ZWQsIGRlZmVycmVkSW5pdGlhbGl6YXRpb24sIHN0cmljdE1vZGU7XG4gICAgICAgICAgICB2YXIgb25SZWFkeU9mZiwgZm9ybWF0UmVjb3JkO1xuICAgICAgICAgICAgdmFyIHJlY29ubmVjdE9mZiwgcHVibGljYXRpb25MaXN0ZW5lck9mZiwgZGVzdHJveU9mZjtcbiAgICAgICAgICAgIHZhciBvYmplY3RDbGFzcztcbiAgICAgICAgICAgIHZhciBzdWJzY3JpcHRpb25JZDtcblxuICAgICAgICAgICAgdmFyIHNEcyA9IHRoaXM7XG4gICAgICAgICAgICB2YXIgc3ViUGFyYW1zID0ge307XG4gICAgICAgICAgICB2YXIgcmVjb3JkU3RhdGVzID0ge307XG4gICAgICAgICAgICB2YXIgaW5uZXJTY29wZTsvLz0gJHJvb3RTY29wZS4kbmV3KHRydWUpO1xuICAgICAgICAgICAgdmFyIHN5bmNMaXN0ZW5lciA9IG5ldyBTeW5jTGlzdGVuZXIoKTtcblxuXG4gICAgICAgICAgICB0aGlzLnJlYWR5ID0gZmFsc2U7XG4gICAgICAgICAgICB0aGlzLnN5bmNPbiA9IHN5bmNPbjtcbiAgICAgICAgICAgIHRoaXMuc3luY09mZiA9IHN5bmNPZmY7XG4gICAgICAgICAgICB0aGlzLnNldE9uUmVhZHkgPSBzZXRPblJlYWR5O1xuXG4gICAgICAgICAgICB0aGlzLm9uUmVhZHkgPSBvblJlYWR5O1xuICAgICAgICAgICAgdGhpcy5vblVwZGF0ZSA9IG9uVXBkYXRlO1xuICAgICAgICAgICAgdGhpcy5vbkFkZCA9IG9uQWRkO1xuICAgICAgICAgICAgdGhpcy5vblJlbW92ZSA9IG9uUmVtb3ZlO1xuXG4gICAgICAgICAgICB0aGlzLmdldERhdGEgPSBnZXREYXRhO1xuICAgICAgICAgICAgdGhpcy5zZXRQYXJhbWV0ZXJzID0gc2V0UGFyYW1ldGVycztcblxuICAgICAgICAgICAgdGhpcy53YWl0Rm9yRGF0YVJlYWR5ID0gd2FpdEZvckRhdGFSZWFkeTtcbiAgICAgICAgICAgIHRoaXMud2FpdEZvclN1YnNjcmlwdGlvblJlYWR5ID0gd2FpdEZvclN1YnNjcmlwdGlvblJlYWR5O1xuXG4gICAgICAgICAgICB0aGlzLnNldEZvcmNlID0gc2V0Rm9yY2U7XG4gICAgICAgICAgICB0aGlzLmlzU3luY2luZyA9IGlzU3luY2luZztcbiAgICAgICAgICAgIHRoaXMuaXNSZWFkeSA9IGlzUmVhZHk7XG5cbiAgICAgICAgICAgIHRoaXMuc2V0U2luZ2xlID0gc2V0U2luZ2xlO1xuXG4gICAgICAgICAgICB0aGlzLnNldE9iamVjdENsYXNzID0gc2V0T2JqZWN0Q2xhc3M7XG4gICAgICAgICAgICB0aGlzLmdldE9iamVjdENsYXNzID0gZ2V0T2JqZWN0Q2xhc3M7XG5cbiAgICAgICAgICAgIHRoaXMuc2V0U3RyaWN0TW9kZSA9IHNldFN0cmljdE1vZGU7XG5cbiAgICAgICAgICAgIHRoaXMuYXR0YWNoID0gYXR0YWNoO1xuICAgICAgICAgICAgdGhpcy5kZXN0cm95ID0gZGVzdHJveTtcblxuICAgICAgICAgICAgdGhpcy5pc0V4aXN0aW5nU3RhdGVGb3IgPSBpc0V4aXN0aW5nU3RhdGVGb3I7IC8vIGZvciB0ZXN0aW5nIHB1cnBvc2VzXG5cbiAgICAgICAgICAgIHNldFNpbmdsZShmYWxzZSk7XG5cbiAgICAgICAgICAgIC8vIHRoaXMgd2lsbCBtYWtlIHN1cmUgdGhhdCB0aGUgc3Vic2NyaXB0aW9uIGlzIHJlbGVhc2VkIGZyb20gc2VydmVycyBpZiB0aGUgYXBwIGNsb3NlcyAoY2xvc2UgYnJvd3NlciwgcmVmcmVzaC4uLilcbiAgICAgICAgICAgIGF0dGFjaChzY29wZSB8fCAkcm9vdFNjb3BlKTtcblxuICAgICAgICAgICAgLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vL1xuXG4gICAgICAgICAgICBmdW5jdGlvbiBkZXN0cm95KCkge1xuICAgICAgICAgICAgICAgIHN5bmNPZmYoKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLyoqIHRoaXMgd2lsbCBiZSBjYWxsZWQgd2hlbiBkYXRhIGlzIGF2YWlsYWJsZSBcbiAgICAgICAgICAgICAqICBpdCBtZWFucyByaWdodCBhZnRlciBlYWNoIHN5bmMhXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICAqIFxuICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIHNldE9uUmVhZHkoY2FsbGJhY2spIHtcbiAgICAgICAgICAgICAgICBpZiAob25SZWFkeU9mZikge1xuICAgICAgICAgICAgICAgICAgICBvblJlYWR5T2ZmKCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIG9uUmVhZHlPZmYgPSBvblJlYWR5KGNhbGxiYWNrKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqIGZvcmNlIHJlc3luY2luZyBmcm9tIHNjcmF0Y2ggZXZlbiBpZiB0aGUgcGFyYW1ldGVycyBoYXZlIG5vdCBjaGFuZ2VkXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICAqIGlmIG91dHNpZGUgY29kZSBoYXMgbW9kaWZpZWQgdGhlIGRhdGEgYW5kIHlvdSBuZWVkIHRvIHJvbGxiYWNrLCB5b3UgY291bGQgY29uc2lkZXIgZm9yY2luZyBhIHJlZnJlc2ggd2l0aCB0aGlzLiBCZXR0ZXIgc29sdXRpb24gc2hvdWxkIGJlIGZvdW5kIHRoYW4gdGhhdC5cbiAgICAgICAgICAgICAqIFxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBzZXRGb3JjZSh2YWx1ZSkge1xuICAgICAgICAgICAgICAgIGlmICh2YWx1ZSkge1xuICAgICAgICAgICAgICAgICAgICAvLyBxdWljayBoYWNrIHRvIGZvcmNlIHRvIHJlbG9hZC4uLnJlY29kZSBsYXRlci5cbiAgICAgICAgICAgICAgICAgICAgc0RzLnN5bmNPZmYoKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgKiBpZiBzZXQgdG8gdHJ1ZSwgaWYgYW4gb2JqZWN0IHdpdGhpbiBhbiBhcnJheSBwcm9wZXJ0eSBvZiB0aGUgcmVjb3JkIHRvIHN5bmMgaGFzIG5vIElEIGZpZWxkLlxuICAgICAgICAgICAgICogYW4gZXJyb3Igd291bGQgYmUgdGhyb3duLlxuICAgICAgICAgICAgICogSXQgaXMgaW1wb3J0YW50IGlmIHdlIHdhbnQgdG8gYmUgYWJsZSB0byBtYWludGFpbiBpbnN0YW5jZSByZWZlcmVuY2VzIGV2ZW4gZm9yIHRoZSBvYmplY3RzIGluc2lkZSBhcnJheXMuXG4gICAgICAgICAgICAgKlxuICAgICAgICAgICAgICogRm9yY2VzIHVzIHRvIHVzZSBpZCBldmVyeSB3aGVyZS5cbiAgICAgICAgICAgICAqXG4gICAgICAgICAgICAgKiBTaG91bGQgYmUgdGhlIGRlZmF1bHQuLi5idXQgdG9vIHJlc3RyaWN0aXZlIGZvciBub3cuXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIHNldFN0cmljdE1vZGUodmFsdWUpIHtcbiAgICAgICAgICAgICAgICBzdHJpY3RNb2RlID0gdHJ1ZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgKiBUaGUgZm9sbG93aW5nIG9iamVjdCB3aWxsIGJlIGJ1aWx0IHVwb24gZWFjaCByZWNvcmQgcmVjZWl2ZWQgZnJvbSB0aGUgYmFja2VuZFxuICAgICAgICAgICAgICogXG4gICAgICAgICAgICAgKiBUaGlzIGNhbm5vdCBiZSBtb2RpZmllZCBhZnRlciB0aGUgc3luYyBoYXMgc3RhcnRlZC5cbiAgICAgICAgICAgICAqIFxuICAgICAgICAgICAgICogQHBhcmFtIGNsYXNzVmFsdWVcbiAgICAgICAgICAgICAqL1xuICAgICAgICAgICAgZnVuY3Rpb24gc2V0T2JqZWN0Q2xhc3MoY2xhc3NWYWx1ZSkge1xuICAgICAgICAgICAgICAgIGlmIChkZWZlcnJlZEluaXRpYWxpemF0aW9uKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgb2JqZWN0Q2xhc3MgPSBjbGFzc1ZhbHVlO1xuICAgICAgICAgICAgICAgIGZvcm1hdFJlY29yZCA9IGZ1bmN0aW9uIChyZWNvcmQpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIG5ldyBvYmplY3RDbGFzcyhyZWNvcmQpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBzZXRTaW5nbGUoaXNTaW5nbGUpO1xuICAgICAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIGdldE9iamVjdENsYXNzKCkge1xuICAgICAgICAgICAgICAgIHJldHVybiBvYmplY3RDbGFzcztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgKiB0aGlzIGZ1bmN0aW9uIHN0YXJ0cyB0aGUgc3luY2luZy5cbiAgICAgICAgICAgICAqIE9ubHkgcHVibGljYXRpb24gcHVzaGluZyBkYXRhIG1hdGNoaW5nIG91ciBmZXRjaGluZyBwYXJhbXMgd2lsbCBiZSByZWNlaXZlZC5cbiAgICAgICAgICAgICAqIFxuICAgICAgICAgICAgICogZXg6IGZvciBhIHB1YmxpY2F0aW9uIG5hbWVkIFwibWFnYXppbmVzLnN5bmNcIiwgaWYgZmV0Y2hpbmcgcGFyYW1zIGVxdWFsbGVkIHttYWdhemluTmFtZTonY2Fycyd9LCB0aGUgbWFnYXppbmUgY2FycyBkYXRhIHdvdWxkIGJlIHJlY2VpdmVkIGJ5IHRoaXMgc3Vic2NyaXB0aW9uLlxuICAgICAgICAgICAgICogXG4gICAgICAgICAgICAgKiBAcGFyYW0gZmV0Y2hpbmdQYXJhbXNcbiAgICAgICAgICAgICAqIEBwYXJhbSBvcHRpb25zXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICAqIEByZXR1cm5zIGEgcHJvbWlzZSB0aGF0IHJlc29sdmVzIHdoZW4gZGF0YSBpcyBhcnJpdmVkLlxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBzZXRQYXJhbWV0ZXJzKGZldGNoaW5nUGFyYW1zLCBvcHRpb25zKSB7XG4gICAgICAgICAgICAgICAgaWYgKGlzU3luY2luZ09uICYmIGFuZ3VsYXIuZXF1YWxzKGZldGNoaW5nUGFyYW1zLCBzdWJQYXJhbXMpKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIGlmIHRoZSBwYXJhbXMgaGF2ZSBub3QgY2hhbmdlZCwganVzdCByZXR1cm5zIHdpdGggY3VycmVudCBkYXRhLlxuICAgICAgICAgICAgICAgICAgICByZXR1cm4gc0RzOyAvLyRxLnJlc29sdmUoZ2V0RGF0YSgpKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgc3luY09mZigpO1xuICAgICAgICAgICAgICAgIGlmICghaXNTaW5nbGUpIHtcbiAgICAgICAgICAgICAgICAgICAgY2FjaGUubGVuZ3RoID0gMDtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBzdWJQYXJhbXMgPSBmZXRjaGluZ1BhcmFtcyB8fCB7fTtcbiAgICAgICAgICAgICAgICBvcHRpb25zID0gb3B0aW9ucyB8fCB7fTtcbiAgICAgICAgICAgICAgICBpZiAoYW5ndWxhci5pc0RlZmluZWQob3B0aW9ucy5zaW5nbGUpKSB7XG4gICAgICAgICAgICAgICAgICAgIHNldFNpbmdsZShvcHRpb25zLnNpbmdsZSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHN5bmNPbigpO1xuICAgICAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIHdhaXQgZm9yIHRoZSBpbml0aWFsIGZldGNoIHRvIGNvbXBsZXRlIHRoZW4gcmV0dXJucyB0aGlzIHN1YnNjcmlwdGlvblxuICAgICAgICAgICAgZnVuY3Rpb24gd2FpdEZvclN1YnNjcmlwdGlvblJlYWR5KCkge1xuICAgICAgICAgICAgICAgIHJldHVybiBkZWZlcnJlZEluaXRpYWxpemF0aW9uLnByb21pc2UudGhlbihmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIHdhaXQgZm9yIHRoZSBpbml0aWFsIGZldGNoIHRvIGNvbXBsZXRlIHRoZW4gcmV0dXJucyB0aGUgZGF0YVxuICAgICAgICAgICAgZnVuY3Rpb24gd2FpdEZvckRhdGFSZWFkeSgpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZGVmZXJyZWRJbml0aWFsaXphdGlvbi5wcm9taXNlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyBkb2VzIHRoZSBkYXRhc2V0IHJldHVybnMgb25seSBvbmUgb2JqZWN0PyBub3QgYW4gYXJyYXk/XG4gICAgICAgICAgICBmdW5jdGlvbiBzZXRTaW5nbGUodmFsdWUpIHtcbiAgICAgICAgICAgICAgICBpZiAoZGVmZXJyZWRJbml0aWFsaXphdGlvbikge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHZhciB1cGRhdGVGbjtcbiAgICAgICAgICAgICAgICBpc1NpbmdsZSA9IHZhbHVlO1xuICAgICAgICAgICAgICAgIGlmICh2YWx1ZSkge1xuICAgICAgICAgICAgICAgICAgICB1cGRhdGVGbiA9IHVwZGF0ZVN5bmNlZE9iamVjdDtcbiAgICAgICAgICAgICAgICAgICAgY2FjaGUgPSBvYmplY3RDbGFzcyA/IG5ldyBvYmplY3RDbGFzcyh7fSkgOiB7fTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICB1cGRhdGVGbiA9IHVwZGF0ZVN5bmNlZEFycmF5O1xuICAgICAgICAgICAgICAgICAgICBjYWNoZSA9IFtdO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHVwZGF0ZURhdGFTdG9yYWdlID0gZnVuY3Rpb24gKHJlY29yZCkge1xuICAgICAgICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdXBkYXRlRm4ocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgZS5tZXNzYWdlID0gJ1JlY2VpdmVkIEludmFsaWQgb2JqZWN0IGZyb20gcHVibGljYXRpb24gWycgKyBwdWJsaWNhdGlvbiArICddOiAnICsgSlNPTi5zdHJpbmdpZnkocmVjb3JkKSArICcuIERFVEFJTFM6ICcgKyBlLm1lc3NhZ2U7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBlO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy8gcmV0dXJucyB0aGUgb2JqZWN0IG9yIGFycmF5IGluIHN5bmNcbiAgICAgICAgICAgIGZ1bmN0aW9uIGdldERhdGEoKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGNhY2hlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqIHRoZSBkYXRhc2V0IHdpbGwgc3RhcnQgbGlzdGVuaW5nIHRvIHRoZSBkYXRhc3RyZWFtIFxuICAgICAgICAgICAgICogXG4gICAgICAgICAgICAgKiBOb3RlIER1cmluZyB0aGUgc3luYywgaXQgd2lsbCBhbHNvIGNhbGwgdGhlIG9wdGlvbmFsIGNhbGxiYWNrcyAtIGFmdGVyIHByb2Nlc3NpbmcgRUFDSCByZWNvcmQgcmVjZWl2ZWQuXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICAqIEByZXR1cm5zIGEgcHJvbWlzZSB0aGF0IHdpbGwgYmUgcmVzb2x2ZWQgd2hlbiB0aGUgZGF0YSBpcyByZWFkeS5cbiAgICAgICAgICAgICAqL1xuICAgICAgICAgICAgZnVuY3Rpb24gc3luY09uKCkge1xuICAgICAgICAgICAgICAgIGlmIChpc1N5bmNpbmdPbikge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gZGVmZXJyZWRJbml0aWFsaXphdGlvbi5wcm9taXNlO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBkZWZlcnJlZEluaXRpYWxpemF0aW9uID0gJHEuZGVmZXIoKTtcbiAgICAgICAgICAgICAgICBpc0luaXRpYWxQdXNoQ29tcGxldGVkID0gZmFsc2U7XG4gICAgICAgICAgICAgICAgbG9nSW5mbygnU3luYyAnICsgcHVibGljYXRpb24gKyAnIG9uLiBQYXJhbXM6JyArIEpTT04uc3RyaW5naWZ5KHN1YlBhcmFtcykpO1xuICAgICAgICAgICAgICAgIGlzU3luY2luZ09uID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICByZWdpc3RlclN1YnNjcmlwdGlvbigpO1xuICAgICAgICAgICAgICAgIHJlYWR5Rm9yTGlzdGVuaW5nKCk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGRlZmVycmVkSW5pdGlhbGl6YXRpb24ucHJvbWlzZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgKiB0aGUgZGF0YXNldCBpcyBubyBsb25nZXIgbGlzdGVuaW5nIGFuZCB3aWxsIG5vdCBjYWxsIGFueSBjYWxsYmFja1xuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBzeW5jT2ZmKCkge1xuICAgICAgICAgICAgICAgIGlmIChkZWZlcnJlZEluaXRpYWxpemF0aW9uKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIGlmIHRoZXJlIGlzIGNvZGUgd2FpdGluZyBvbiB0aGlzIHByb21pc2UuLiBleCAobG9hZCBpbiByZXNvbHZlKVxuICAgICAgICAgICAgICAgICAgICBkZWZlcnJlZEluaXRpYWxpemF0aW9uLnJlc29sdmUoZ2V0RGF0YSgpKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgaWYgKGlzU3luY2luZ09uKSB7XG4gICAgICAgICAgICAgICAgICAgIHVucmVnaXN0ZXJTdWJzY3JpcHRpb24oKTtcbiAgICAgICAgICAgICAgICAgICAgaXNTeW5jaW5nT24gPSBmYWxzZTtcblxuICAgICAgICAgICAgICAgICAgICBsb2dJbmZvKCdTeW5jICcgKyBwdWJsaWNhdGlvbiArICcgb2ZmLiBQYXJhbXM6JyArIEpTT04uc3RyaW5naWZ5KHN1YlBhcmFtcykpO1xuICAgICAgICAgICAgICAgICAgICBpZiAocHVibGljYXRpb25MaXN0ZW5lck9mZikge1xuICAgICAgICAgICAgICAgICAgICAgICAgcHVibGljYXRpb25MaXN0ZW5lck9mZigpO1xuICAgICAgICAgICAgICAgICAgICAgICAgcHVibGljYXRpb25MaXN0ZW5lck9mZiA9IG51bGw7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgaWYgKHJlY29ubmVjdE9mZikge1xuICAgICAgICAgICAgICAgICAgICAgICAgcmVjb25uZWN0T2ZmKCk7XG4gICAgICAgICAgICAgICAgICAgICAgICByZWNvbm5lY3RPZmYgPSBudWxsO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBpc1N5bmNpbmcoKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGlzU3luY2luZ09uO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiByZWFkeUZvckxpc3RlbmluZygpIHtcbiAgICAgICAgICAgICAgICBpZiAoIXB1YmxpY2F0aW9uTGlzdGVuZXJPZmYpIHtcbiAgICAgICAgICAgICAgICAgICAgbGlzdGVuRm9yUmVjb25uZWN0aW9uVG9SZXN5bmMoKTtcbiAgICAgICAgICAgICAgICAgICAgbGlzdGVuVG9QdWJsaWNhdGlvbigpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgKiAgQnkgZGVmYXVsdCB0aGUgcm9vdHNjb3BlIGlzIGF0dGFjaGVkIGlmIG5vIHNjb3BlIHdhcyBwcm92aWRlZC4gQnV0IGl0IGlzIHBvc3NpYmxlIHRvIHJlLWF0dGFjaCBpdCB0byBhIGRpZmZlcmVudCBzY29wZS4gaWYgdGhlIHN1YnNjcmlwdGlvbiBkZXBlbmRzIG9uIGEgY29udHJvbGxlci5cbiAgICAgICAgICAgICAqXG4gICAgICAgICAgICAgKiAgRG8gbm90IGF0dGFjaCBhZnRlciBpdCBoYXMgc3luY2VkLlxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBhdHRhY2gobmV3U2NvcGUpIHtcbiAgICAgICAgICAgICAgICBpZiAoZGVmZXJyZWRJbml0aWFsaXphdGlvbikge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBpZiAoZGVzdHJveU9mZikge1xuICAgICAgICAgICAgICAgICAgICBkZXN0cm95T2ZmKCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGlubmVyU2NvcGUgPSBuZXdTY29wZTtcbiAgICAgICAgICAgICAgICBkZXN0cm95T2ZmID0gaW5uZXJTY29wZS4kb24oJyRkZXN0cm95JywgZGVzdHJveSk7XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBsaXN0ZW5Gb3JSZWNvbm5lY3Rpb25Ub1Jlc3luYyhsaXN0ZW5Ob3cpIHtcbiAgICAgICAgICAgICAgICAvLyBnaXZlIGEgY2hhbmNlIHRvIGNvbm5lY3QgYmVmb3JlIGxpc3RlbmluZyB0byByZWNvbm5lY3Rpb24uLi4gQFRPRE8gc2hvdWxkIGhhdmUgdXNlcl9yZWNvbm5lY3RlZF9ldmVudFxuICAgICAgICAgICAgICAgIHNldFRpbWVvdXQoZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgICAgICByZWNvbm5lY3RPZmYgPSBpbm5lclNjb3BlLiRvbigndXNlcl9jb25uZWN0ZWQnLCBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsb2dEZWJ1ZygnUmVzeW5jaW5nIGFmdGVyIG5ldHdvcmsgbG9zcyB0byAnICsgcHVibGljYXRpb24pO1xuICAgICAgICAgICAgICAgICAgICAgICAgLy8gbm90ZSB0aGUgYmFja2VuZCBtaWdodCByZXR1cm4gYSBuZXcgc3Vic2NyaXB0aW9uIGlmIHRoZSBjbGllbnQgdG9vayB0b28gbXVjaCB0aW1lIHRvIHJlY29ubmVjdC5cbiAgICAgICAgICAgICAgICAgICAgICAgIHJlZ2lzdGVyU3Vic2NyaXB0aW9uKCk7XG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH0sIGxpc3Rlbk5vdyA/IDAgOiAyMDAwKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gcmVnaXN0ZXJTdWJzY3JpcHRpb24oKSB7XG4gICAgICAgICAgICAgICAgJHNvY2tldGlvLmZldGNoKCdzeW5jLnN1YnNjcmliZScsIHtcbiAgICAgICAgICAgICAgICAgICAgdmVyc2lvbjogU1lOQ19WRVJTSU9OLFxuICAgICAgICAgICAgICAgICAgICBpZDogc3Vic2NyaXB0aW9uSWQsIC8vIHRvIHRyeSB0byByZS11c2UgZXhpc3Rpbmcgc3ViY3JpcHRpb25cbiAgICAgICAgICAgICAgICAgICAgcHVibGljYXRpb246IHB1YmxpY2F0aW9uLFxuICAgICAgICAgICAgICAgICAgICBwYXJhbXM6IHN1YlBhcmFtc1xuICAgICAgICAgICAgICAgIH0pLnRoZW4oZnVuY3Rpb24gKHN1YklkKSB7XG4gICAgICAgICAgICAgICAgICAgIHN1YnNjcmlwdGlvbklkID0gc3ViSWQ7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIHVucmVnaXN0ZXJTdWJzY3JpcHRpb24oKSB7XG4gICAgICAgICAgICAgICAgaWYgKHN1YnNjcmlwdGlvbklkKSB7XG4gICAgICAgICAgICAgICAgICAgICRzb2NrZXRpby5mZXRjaCgnc3luYy51bnN1YnNjcmliZScsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHZlcnNpb246IFNZTkNfVkVSU0lPTixcbiAgICAgICAgICAgICAgICAgICAgICAgIGlkOiBzdWJzY3JpcHRpb25JZFxuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgc3Vic2NyaXB0aW9uSWQgPSBudWxsO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gbGlzdGVuVG9QdWJsaWNhdGlvbigpIHtcbiAgICAgICAgICAgICAgICAvLyBjYW5ub3Qgb25seSBsaXN0ZW4gdG8gc3Vic2NyaXB0aW9uSWQgeWV0Li4uYmVjYXVzZSB0aGUgcmVnaXN0cmF0aW9uIG1pZ2h0IGhhdmUgYW5zd2VyIHByb3ZpZGVkIGl0cyBpZCB5ZXQuLi5idXQgc3RhcnRlZCBicm9hZGNhc3RpbmcgY2hhbmdlcy4uLkBUT0RPIGNhbiBiZSBpbXByb3ZlZC4uLlxuICAgICAgICAgICAgICAgIHB1YmxpY2F0aW9uTGlzdGVuZXJPZmYgPSBhZGRQdWJsaWNhdGlvbkxpc3RlbmVyKHB1YmxpY2F0aW9uLCBmdW5jdGlvbiAoYmF0Y2gpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHN1YnNjcmlwdGlvbklkID09PSBiYXRjaC5zdWJzY3JpcHRpb25JZCB8fCAoIXN1YnNjcmlwdGlvbklkICYmIGNoZWNrRGF0YVNldFBhcmFtc0lmTWF0Y2hpbmdCYXRjaFBhcmFtcyhiYXRjaC5wYXJhbXMpKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFiYXRjaC5kaWZmKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLy8gQ2xlYXIgdGhlIGNhY2hlIHRvIHJlYnVpbGQgaXQgaWYgYWxsIGRhdGEgd2FzIHJlY2VpdmVkLlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlY29yZFN0YXRlcyA9IHt9O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghaXNTaW5nbGUpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FjaGUubGVuZ3RoID0gMDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICBhcHBseUNoYW5nZXMoYmF0Y2gucmVjb3Jkcyk7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWlzSW5pdGlhbFB1c2hDb21wbGV0ZWQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpc0luaXRpYWxQdXNoQ29tcGxldGVkID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkZWZlcnJlZEluaXRpYWxpemF0aW9uLnJlc29sdmUoZ2V0RGF0YSgpKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICogaWYgdGhlIHBhcmFtcyBvZiB0aGUgZGF0YXNldCBtYXRjaGVzIHRoZSBub3RpZmljYXRpb24sIGl0IG1lYW5zIHRoZSBkYXRhIG5lZWRzIHRvIGJlIGNvbGxlY3QgdG8gdXBkYXRlIGFycmF5LlxuICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIGNoZWNrRGF0YVNldFBhcmFtc0lmTWF0Y2hpbmdCYXRjaFBhcmFtcyhiYXRjaFBhcmFtcykge1xuICAgICAgICAgICAgICAgIC8vIGlmIChwYXJhbXMubGVuZ3RoICE9IHN0cmVhbVBhcmFtcy5sZW5ndGgpIHtcbiAgICAgICAgICAgICAgICAvLyAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgICAgIC8vIH1cbiAgICAgICAgICAgICAgICBpZiAoIXN1YlBhcmFtcyB8fCBPYmplY3Qua2V5cyhzdWJQYXJhbXMpLmxlbmd0aCA9PSAwKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB0cnVlXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHZhciBtYXRjaGluZyA9IHRydWU7XG4gICAgICAgICAgICAgICAgZm9yICh2YXIgcGFyYW0gaW4gYmF0Y2hQYXJhbXMpIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gYXJlIG90aGVyIHBhcmFtcyBtYXRjaGluZz9cbiAgICAgICAgICAgICAgICAgICAgLy8gZXg6IHdlIG1pZ2h0IGhhdmUgcmVjZWl2ZSBhIG5vdGlmaWNhdGlvbiBhYm91dCB0YXNrSWQ9MjAgYnV0IHRoaXMgc3Vic2NyaXB0aW9uIGFyZSBvbmx5IGludGVyZXN0ZWQgYWJvdXQgdGFza0lkLTNcbiAgICAgICAgICAgICAgICAgICAgaWYgKGJhdGNoUGFyYW1zW3BhcmFtXSAhPT0gc3ViUGFyYW1zW3BhcmFtXSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgbWF0Y2hpbmcgPSBmYWxzZTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHJldHVybiBtYXRjaGluZztcblxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyBmZXRjaCBhbGwgdGhlIG1pc3NpbmcgcmVjb3JkcywgYW5kIGFjdGl2YXRlIHRoZSBjYWxsIGJhY2tzIChhZGQsdXBkYXRlLHJlbW92ZSkgYWNjb3JkaW5nbHkgaWYgdGhlcmUgaXMgc29tZXRoaW5nIHRoYXQgaXMgbmV3IG9yIG5vdCBhbHJlYWR5IGluIHN5bmMuXG4gICAgICAgICAgICBmdW5jdGlvbiBhcHBseUNoYW5nZXMocmVjb3Jkcykge1xuICAgICAgICAgICAgICAgIHZhciBuZXdEYXRhQXJyYXkgPSBbXTtcbiAgICAgICAgICAgICAgICB2YXIgbmV3RGF0YTtcbiAgICAgICAgICAgICAgICBzRHMucmVhZHkgPSBmYWxzZTtcbiAgICAgICAgICAgICAgICByZWNvcmRzLmZvckVhY2goZnVuY3Rpb24gKHJlY29yZCkge1xuICAgICAgICAgICAgICAgICAgICAvLyAgICAgICAgICAgICAgICAgICBsb2dJbmZvKCdEYXRhc3luYyBbJyArIGRhdGFTdHJlYW1OYW1lICsgJ10gcmVjZWl2ZWQ6JyArSlNPTi5zdHJpbmdpZnkocmVjb3JkKSk7Ly8rIHJlY29yZC5pZCk7XG4gICAgICAgICAgICAgICAgICAgIGlmIChyZWNvcmQucmVtb3ZlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZW1vdmVSZWNvcmQocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIGlmIChyZWNvcmRTdGF0ZXNbcmVjb3JkLmlkXSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy8gaWYgdGhlIHJlY29yZCBpcyBhbHJlYWR5IHByZXNlbnQgaW4gdGhlIGNhY2hlLi4uc28gaXQgaXMgbWlnaHRiZSBhbiB1cGRhdGUuLlxuICAgICAgICAgICAgICAgICAgICAgICAgbmV3RGF0YSA9IHVwZGF0ZVJlY29yZChyZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgbmV3RGF0YSA9IGFkZFJlY29yZChyZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIGlmIChuZXdEYXRhKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBuZXdEYXRhQXJyYXkucHVzaChuZXdEYXRhKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIHNEcy5yZWFkeSA9IHRydWU7XG4gICAgICAgICAgICAgICAgaWYgKGlzU2luZ2xlKSB7XG4gICAgICAgICAgICAgICAgICAgIHN5bmNMaXN0ZW5lci5ub3RpZnkoJ3JlYWR5JywgZ2V0RGF0YSgpKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzeW5jTGlzdGVuZXIubm90aWZ5KCdyZWFkeScsIGdldERhdGEoKSwgbmV3RGF0YUFycmF5KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogQWx0aG91Z2ggbW9zdCBjYXNlcyBhcmUgaGFuZGxlZCB1c2luZyBvblJlYWR5LCB0aGlzIHRlbGxzIHlvdSB0aGUgY3VycmVudCBkYXRhIHN0YXRlLlxuICAgICAgICAgICAgICogXG4gICAgICAgICAgICAgKiBAcmV0dXJucyBpZiB0cnVlIGlzIGEgc3luYyBoYXMgYmVlbiBwcm9jZXNzZWQgb3RoZXJ3aXNlIGZhbHNlIGlmIHRoZSBkYXRhIGlzIG5vdCByZWFkeS5cbiAgICAgICAgICAgICAqL1xuICAgICAgICAgICAgZnVuY3Rpb24gaXNSZWFkeSgpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5yZWFkeTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogXG4gICAgICAgICAgICAgKiByZXR1cm5zIGEgZnVuY3Rpb24gdG8gcmVtb3ZlIHRoZSBsaXN0ZW5lci5cbiAgICAgICAgICAgICAqL1xuICAgICAgICAgICAgZnVuY3Rpb24gb25BZGQoY2FsbGJhY2spIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gc3luY0xpc3RlbmVyLm9uKCdhZGQnLCBjYWxsYmFjayk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogXG4gICAgICAgICAgICAgKiByZXR1cm5zIGEgZnVuY3Rpb24gdG8gcmVtb3ZlIHRoZSBsaXN0ZW5lci5cbiAgICAgICAgICAgICAqL1xuICAgICAgICAgICAgZnVuY3Rpb24gb25VcGRhdGUoY2FsbGJhY2spIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gc3luY0xpc3RlbmVyLm9uKCd1cGRhdGUnLCBjYWxsYmFjayk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogXG4gICAgICAgICAgICAgKiByZXR1cm5zIGEgZnVuY3Rpb24gdG8gcmVtb3ZlIHRoZSBsaXN0ZW5lci5cbiAgICAgICAgICAgICAqL1xuICAgICAgICAgICAgZnVuY3Rpb24gb25SZW1vdmUoY2FsbGJhY2spIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gc3luY0xpc3RlbmVyLm9uKCdyZW1vdmUnLCBjYWxsYmFjayk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogXG4gICAgICAgICAgICAgKiByZXR1cm5zIGEgZnVuY3Rpb24gdG8gcmVtb3ZlIHRoZSBsaXN0ZW5lci5cbiAgICAgICAgICAgICAqL1xuICAgICAgICAgICAgZnVuY3Rpb24gb25SZWFkeShjYWxsYmFjaykge1xuICAgICAgICAgICAgICAgIHJldHVybiBzeW5jTGlzdGVuZXIub24oJ3JlYWR5JywgY2FsbGJhY2spO1xuICAgICAgICAgICAgfVxuXG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIGFkZFJlY29yZChyZWNvcmQpIHtcbiAgICAgICAgICAgICAgICBsb2dEZWJ1ZygnU3luYyAtPiBJbnNlcnRlZCBOZXcgcmVjb3JkICMnICsgcmVjb3JkLmlkICsgJyBmb3Igc3Vic2NyaXB0aW9uIHRvICcgKyBwdWJsaWNhdGlvbik7Ly8gSlNPTi5zdHJpbmdpZnkocmVjb3JkKSk7XG4gICAgICAgICAgICAgICAgZ2V0UmV2aXNpb24ocmVjb3JkKTsgLy8ganVzdCBtYWtlIHN1cmUgd2UgY2FuIGdldCBhIHJldmlzaW9uIGJlZm9yZSB3ZSBoYW5kbGUgdGhpcyByZWNvcmRcbiAgICAgICAgICAgICAgICB1cGRhdGVEYXRhU3RvcmFnZShmb3JtYXRSZWNvcmQgPyBmb3JtYXRSZWNvcmQocmVjb3JkKSA6IHJlY29yZCk7XG4gICAgICAgICAgICAgICAgc3luY0xpc3RlbmVyLm5vdGlmeSgnYWRkJywgcmVjb3JkKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gcmVjb3JkO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiB1cGRhdGVSZWNvcmQocmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgdmFyIHByZXZpb3VzID0gcmVjb3JkU3RhdGVzW3JlY29yZC5pZF07XG4gICAgICAgICAgICAgICAgaWYgKGdldFJldmlzaW9uKHJlY29yZCkgPD0gZ2V0UmV2aXNpb24ocHJldmlvdXMpKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBudWxsO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBsb2dEZWJ1ZygnU3luYyAtPiBVcGRhdGVkIHJlY29yZCAjJyArIHJlY29yZC5pZCArICcgZm9yIHN1YnNjcmlwdGlvbiB0byAnICsgcHVibGljYXRpb24pOy8vIEpTT04uc3RyaW5naWZ5KHJlY29yZCkpO1xuICAgICAgICAgICAgICAgIHVwZGF0ZURhdGFTdG9yYWdlKGZvcm1hdFJlY29yZCA/IGZvcm1hdFJlY29yZChyZWNvcmQpIDogcmVjb3JkKTtcbiAgICAgICAgICAgICAgICBzeW5jTGlzdGVuZXIubm90aWZ5KCd1cGRhdGUnLCByZWNvcmQpO1xuICAgICAgICAgICAgICAgIHJldHVybiByZWNvcmQ7XG4gICAgICAgICAgICB9XG5cblxuICAgICAgICAgICAgZnVuY3Rpb24gcmVtb3ZlUmVjb3JkKHJlY29yZCkge1xuICAgICAgICAgICAgICAgIHZhciBwcmV2aW91cyA9IHJlY29yZFN0YXRlc1tyZWNvcmQuaWRdO1xuICAgICAgICAgICAgICAgIGlmICghcHJldmlvdXMgfHwgZ2V0UmV2aXNpb24ocmVjb3JkKSA+IGdldFJldmlzaW9uKHByZXZpb3VzKSkge1xuICAgICAgICAgICAgICAgICAgICBsb2dEZWJ1ZygnU3luYyAtPiBSZW1vdmVkICMnICsgcmVjb3JkLmlkICsgJyBmb3Igc3Vic2NyaXB0aW9uIHRvICcgKyBwdWJsaWNhdGlvbik7XG4gICAgICAgICAgICAgICAgICAgIC8vIFdlIGNvdWxkIGhhdmUgZm9yIHRoZSBzYW1lIHJlY29yZCBjb25zZWN1dGl2ZWx5IGZldGNoaW5nIGluIHRoaXMgb3JkZXI6XG4gICAgICAgICAgICAgICAgICAgIC8vIGRlbGV0ZSBpZDo0LCByZXYgMTAsIHRoZW4gYWRkIGlkOjQsIHJldiA5Li4uLiBieSBrZWVwaW5nIHRyYWNrIG9mIHdoYXQgd2FzIGRlbGV0ZWQsIHdlIHdpbGwgbm90IGFkZCB0aGUgcmVjb3JkIHNpbmNlIGl0IHdhcyBkZWxldGVkIHdpdGggYSBtb3N0IHJlY2VudCB0aW1lc3RhbXAuXG4gICAgICAgICAgICAgICAgICAgIHJlY29yZC5yZW1vdmVkID0gdHJ1ZTsgLy8gU28gd2Ugb25seSBmbGFnIGFzIHJlbW92ZWQsIGxhdGVyIG9uIHRoZSBnYXJiYWdlIGNvbGxlY3RvciB3aWxsIGdldCByaWQgb2YgaXQuICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHVwZGF0ZURhdGFTdG9yYWdlKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgIC8vIGlmIHRoZXJlIGlzIG5vIHByZXZpb3VzIHJlY29yZCB3ZSBkbyBub3QgbmVlZCB0byByZW1vdmVkIGFueSB0aGluZyBmcm9tIG91ciBzdG9yYWdlLiAgICAgXG4gICAgICAgICAgICAgICAgICAgIGlmIChwcmV2aW91cykge1xuICAgICAgICAgICAgICAgICAgICAgICAgc3luY0xpc3RlbmVyLm5vdGlmeSgncmVtb3ZlJywgcmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGRpc3Bvc2UocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGZ1bmN0aW9uIGRpc3Bvc2UocmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgJHN5bmNHYXJiYWdlQ29sbGVjdG9yLmRpc3Bvc2UoZnVuY3Rpb24gY29sbGVjdCgpIHtcbiAgICAgICAgICAgICAgICAgICAgdmFyIGV4aXN0aW5nUmVjb3JkID0gcmVjb3JkU3RhdGVzW3JlY29yZC5pZF07XG4gICAgICAgICAgICAgICAgICAgIGlmIChleGlzdGluZ1JlY29yZCAmJiByZWNvcmQucmV2aXNpb24gPj0gZXhpc3RpbmdSZWNvcmQucmV2aXNpb25cbiAgICAgICAgICAgICAgICAgICAgKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvL2xvZ0RlYnVnKCdDb2xsZWN0IE5vdzonICsgSlNPTi5zdHJpbmdpZnkocmVjb3JkKSk7XG4gICAgICAgICAgICAgICAgICAgICAgICBkZWxldGUgcmVjb3JkU3RhdGVzW3JlY29yZC5pZF07XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gaXNFeGlzdGluZ1N0YXRlRm9yKHJlY29yZElkKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuICEhcmVjb3JkU3RhdGVzW3JlY29yZElkXTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gdXBkYXRlU3luY2VkT2JqZWN0KHJlY29yZCkge1xuICAgICAgICAgICAgICAgIHJlY29yZFN0YXRlc1tyZWNvcmQuaWRdID0gcmVjb3JkO1xuXG4gICAgICAgICAgICAgICAgaWYgKCFyZWNvcmQucmVtb3ZlKSB7XG4gICAgICAgICAgICAgICAgICAgICRzeW5jTWVyZ2UubWVyZ2UoY2FjaGUsIHJlY29yZCwgc3RyaWN0TW9kZSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgJHN5bmNNZXJnZS5jbGVhck9iamVjdChjYWNoZSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiB1cGRhdGVTeW5jZWRBcnJheShyZWNvcmQpIHtcbiAgICAgICAgICAgICAgICB2YXIgZXhpc3RpbmcgPSByZWNvcmRTdGF0ZXNbcmVjb3JkLmlkXTtcbiAgICAgICAgICAgICAgICBpZiAoIWV4aXN0aW5nKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIGFkZCBuZXcgaW5zdGFuY2VcbiAgICAgICAgICAgICAgICAgICAgcmVjb3JkU3RhdGVzW3JlY29yZC5pZF0gPSByZWNvcmQ7XG4gICAgICAgICAgICAgICAgICAgIGlmICghcmVjb3JkLnJlbW92ZWQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNhY2hlLnB1c2gocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICRzeW5jTWVyZ2UubWVyZ2UoZXhpc3RpbmcsIHJlY29yZCwgc3RyaWN0TW9kZSk7XG4gICAgICAgICAgICAgICAgICAgIGlmIChyZWNvcmQucmVtb3ZlZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgY2FjaGUuc3BsaWNlKGNhY2hlLmluZGV4T2YoZXhpc3RpbmcpLCAxKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuXG5cblxuXG4gICAgICAgICAgICBmdW5jdGlvbiBnZXRSZXZpc2lvbihyZWNvcmQpIHtcbiAgICAgICAgICAgICAgICAvLyB3aGF0IHJlc2VydmVkIGZpZWxkIGRvIHdlIHVzZSBhcyB0aW1lc3RhbXBcbiAgICAgICAgICAgICAgICBpZiAoYW5ndWxhci5pc0RlZmluZWQocmVjb3JkLnJldmlzaW9uKSkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gcmVjb3JkLnJldmlzaW9uO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBpZiAoYW5ndWxhci5pc0RlZmluZWQocmVjb3JkLnRpbWVzdGFtcCkpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHJlY29yZC50aW1lc3RhbXA7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignU3luYyByZXF1aXJlcyBhIHJldmlzaW9uIG9yIHRpbWVzdGFtcCBwcm9wZXJ0eSBpbiByZWNlaXZlZCAnICsgKG9iamVjdENsYXNzID8gJ29iamVjdCBbJyArIG9iamVjdENsYXNzLm5hbWUgKyAnXScgOiAncmVjb3JkJykpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqIHRoaXMgb2JqZWN0IFxuICAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gU3luY0xpc3RlbmVyKCkge1xuICAgICAgICAgICAgdmFyIGV2ZW50cyA9IHt9O1xuICAgICAgICAgICAgdmFyIGNvdW50ID0gMDtcblxuICAgICAgICAgICAgdGhpcy5ub3RpZnkgPSBub3RpZnk7XG4gICAgICAgICAgICB0aGlzLm9uID0gb247XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIG5vdGlmeShldmVudCwgZGF0YTEsIGRhdGEyKSB7XG4gICAgICAgICAgICAgICAgdmFyIGxpc3RlbmVycyA9IGV2ZW50c1tldmVudF07XG4gICAgICAgICAgICAgICAgaWYgKGxpc3RlbmVycykge1xuICAgICAgICAgICAgICAgICAgICBfLmZvckVhY2gobGlzdGVuZXJzLCBmdW5jdGlvbiAoY2FsbGJhY2ssIGlkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjYWxsYmFjayhkYXRhMSwgZGF0YTIpO1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogQHJldHVybnMgaGFuZGxlciB0byB1bnJlZ2lzdGVyIGxpc3RlbmVyXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIG9uKGV2ZW50LCBjYWxsYmFjaykge1xuICAgICAgICAgICAgICAgIHZhciBsaXN0ZW5lcnMgPSBldmVudHNbZXZlbnRdO1xuICAgICAgICAgICAgICAgIGlmICghbGlzdGVuZXJzKSB7XG4gICAgICAgICAgICAgICAgICAgIGxpc3RlbmVycyA9IGV2ZW50c1tldmVudF0gPSB7fTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgdmFyIGlkID0gY291bnQrKztcbiAgICAgICAgICAgICAgICBsaXN0ZW5lcnNbaWQrK10gPSBjYWxsYmFjaztcbiAgICAgICAgICAgICAgICByZXR1cm4gZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgICAgICBkZWxldGUgbGlzdGVuZXJzW2lkXTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9O1xuXG4gICAgZnVuY3Rpb24gbG9nSW5mbyhtc2cpIHtcbiAgICAgICAgaWYgKGRlYnVnKSB7XG4gICAgICAgICAgICBjb25zb2xlLmRlYnVnKCdTWU5DKGluZm8pOiAnICsgbXNnKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGZ1bmN0aW9uIGxvZ0RlYnVnKG1zZykge1xuICAgICAgICBpZiAoZGVidWcgPT0gMikge1xuICAgICAgICAgICAgY29uc29sZS5kZWJ1ZygnU1lOQyhkZWJ1Zyk6ICcgKyBtc2cpO1xuICAgICAgICB9XG5cbiAgICB9XG5cblxuXG59O1xuXG4iXX0=
