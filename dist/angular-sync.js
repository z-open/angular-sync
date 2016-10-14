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

//# sourceMappingURL=data:application/json;charset=utf8;base64,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SUFNQSxTQUFBLFFBQUEsS0FBQTtRQUNBLElBQUEsT0FBQTtZQUNBLFFBQUEsTUFBQSxpQkFBQTs7OztJQUlBLFNBQUEsU0FBQSxLQUFBO1FBQ0EsSUFBQSxTQUFBLEdBQUE7WUFDQSxRQUFBLE1BQUEsa0JBQUE7Ozs7Ozs7Q0FPQTs7QUFFQSIsImZpbGUiOiJhbmd1bGFyLXN5bmMuanMiLCJzb3VyY2VzQ29udGVudCI6WyIoZnVuY3Rpb24oKSB7XG5cInVzZSBzdHJpY3RcIjtcblxuYW5ndWxhclxuICAgIC5tb2R1bGUoJ3N5bmMnLCBbJ3NvY2tldGlvLWF1dGgnXSlcbiAgICAuY29uZmlnKGZ1bmN0aW9uKCRzb2NrZXRpb1Byb3ZpZGVyKXtcbiAgICAgICAgJHNvY2tldGlvUHJvdmlkZXIuc2V0RGVidWcodHJ1ZSk7XG4gICAgfSk7XG59KCkpO1xuXG4oZnVuY3Rpb24oKSB7XG5cInVzZSBzdHJpY3RcIjtcblxuYW5ndWxhclxuICAgIC5tb2R1bGUoJ3N5bmMnKVxuICAgIC5mYWN0b3J5KCckc3luY0dhcmJhZ2VDb2xsZWN0b3InLCBzeW5jR2FyYmFnZUNvbGxlY3Rvcik7XG5cbi8qKlxuICogc2FmZWx5IHJlbW92ZSBkZWxldGVkIHJlY29yZC9vYmplY3QgZnJvbSBtZW1vcnkgYWZ0ZXIgdGhlIHN5bmMgcHJvY2VzcyBkaXNwb3NlZCB0aGVtLlxuICogXG4gKiBUT0RPOiBTZWNvbmRzIHNob3VsZCByZWZsZWN0IHRoZSBtYXggdGltZSAgdGhhdCBzeW5jIGNhY2hlIGlzIHZhbGlkIChuZXR3b3JrIGxvc3Mgd291bGQgZm9yY2UgYSByZXN5bmMpLCB3aGljaCBzaG91bGQgbWF0Y2ggbWF4RGlzY29ubmVjdGlvblRpbWVCZWZvcmVEcm9wcGluZ1N1YnNjcmlwdGlvbiBvbiB0aGUgc2VydmVyIHNpZGUuXG4gKiBcbiAqIE5vdGU6XG4gKiByZW1vdmVkIHJlY29yZCBzaG91bGQgYmUgZGVsZXRlZCBmcm9tIHRoZSBzeW5jIGludGVybmFsIGNhY2hlIGFmdGVyIGEgd2hpbGUgc28gdGhhdCB0aGV5IGRvIG5vdCBzdGF5IGluIHRoZSBtZW1vcnkuIFRoZXkgY2Fubm90IGJlIHJlbW92ZWQgdG9vIGVhcmx5IGFzIGFuIG9sZGVyIHZlcnNpb24vc3RhbXAgb2YgdGhlIHJlY29yZCBjb3VsZCBiZSByZWNlaXZlZCBhZnRlciBpdHMgcmVtb3ZhbC4uLndoaWNoIHdvdWxkIHJlLWFkZCB0byBjYWNoZS4uLmR1ZSBhc3luY2hyb25vdXMgcHJvY2Vzc2luZy4uLlxuICovXG5mdW5jdGlvbiBzeW5jR2FyYmFnZUNvbGxlY3RvcigpIHtcbiAgICB2YXIgaXRlbXMgPSBbXTtcbiAgICB2YXIgc2Vjb25kcyA9IDI7XG4gICAgdmFyIHNjaGVkdWxlZCA9IGZhbHNlO1xuXG4gICAgdmFyIHNlcnZpY2UgPSB7XG4gICAgICAgIHNldFNlY29uZHM6IHNldFNlY29uZHMsXG4gICAgICAgIGdldFNlY29uZHM6IGdldFNlY29uZHMsXG4gICAgICAgIGRpc3Bvc2U6IGRpc3Bvc2UsXG4gICAgICAgIHNjaGVkdWxlOiBzY2hlZHVsZSxcbiAgICAgICAgcnVuOiBydW4sXG4gICAgICAgIGdldEl0ZW1Db3VudDogZ2V0SXRlbUNvdW50XG4gICAgfTtcblxuICAgIHJldHVybiBzZXJ2aWNlO1xuXG4gICAgLy8vLy8vLy8vL1xuXG4gICAgZnVuY3Rpb24gc2V0U2Vjb25kcyh2YWx1ZSkge1xuICAgICAgICBzZWNvbmRzID0gdmFsdWU7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gZ2V0U2Vjb25kcygpIHtcbiAgICAgICAgcmV0dXJuIHNlY29uZHM7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gZ2V0SXRlbUNvdW50KCkge1xuICAgICAgICByZXR1cm4gaXRlbXMubGVuZ3RoO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIGRpc3Bvc2UoY29sbGVjdCkge1xuICAgICAgICBpdGVtcy5wdXNoKHtcbiAgICAgICAgICAgIHRpbWVzdGFtcDogRGF0ZS5ub3coKSxcbiAgICAgICAgICAgIGNvbGxlY3Q6IGNvbGxlY3RcbiAgICAgICAgfSk7XG4gICAgICAgIGlmICghc2NoZWR1bGVkKSB7XG4gICAgICAgICAgICBzZXJ2aWNlLnNjaGVkdWxlKCk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBmdW5jdGlvbiBzY2hlZHVsZSgpIHtcbiAgICAgICAgaWYgKCFzZWNvbmRzKSB7XG4gICAgICAgICAgICBzZXJ2aWNlLnJ1bigpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIHNjaGVkdWxlZCA9IHRydWU7XG4gICAgICAgIHNldFRpbWVvdXQoZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgc2VydmljZS5ydW4oKTtcbiAgICAgICAgICAgIGlmIChpdGVtcy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICAgICAgc2NoZWR1bGUoKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgc2NoZWR1bGVkID0gZmFsc2U7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0sIHNlY29uZHMgKiAxMDAwKTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBydW4oKSB7XG4gICAgICAgIHZhciB0aW1lb3V0ID0gRGF0ZS5ub3coKSAtIHNlY29uZHMgKiAxMDAwO1xuICAgICAgICB3aGlsZSAoaXRlbXMubGVuZ3RoID4gMCAmJiBpdGVtc1swXS50aW1lc3RhbXAgPD0gdGltZW91dCkge1xuICAgICAgICAgICAgaXRlbXMuc2hpZnQoKS5jb2xsZWN0KCk7XG4gICAgICAgIH1cbiAgICB9XG59XG59KCkpO1xuXG4oZnVuY3Rpb24oKSB7XG5cInVzZSBzdHJpY3RcIjtcblxuYW5ndWxhclxuICAgIC5tb2R1bGUoJ3N5bmMnKVxuICAgIC5mYWN0b3J5KCckc3luY01lcmdlJywgc3luY01lcmdlKTtcblxuZnVuY3Rpb24gc3luY01lcmdlKCkge1xuXG4gICAgcmV0dXJuIHtcbiAgICAgICAgbWVyZ2U6IG1lcmdlT2JqZWN0LFxuICAgICAgICBjbGVhck9iamVjdDogY2xlYXJPYmplY3RcbiAgICB9XG5cblxuICAgIC8qKiBtZXJnZSBhbiBvYmplY3Qgd2l0aCBhbiBvdGhlci4gTWVyZ2UgYWxzbyBpbm5lciBvYmplY3RzIGFuZCBvYmplY3RzIGluIGFycmF5LiBcbiAgICAgKiBSZWZlcmVuY2UgdG8gdGhlIG9yaWdpbmFsIG9iamVjdHMgYXJlIG1haW50YWluZWQgaW4gdGhlIGRlc3RpbmF0aW9uIG9iamVjdC5cbiAgICAgKiBPbmx5IGNvbnRlbnQgaXMgdXBkYXRlZC5cbiAgICAgKlxuICAgICAqQHBhcmFtIDxvYmplY3Q+IGRlc3RpbmF0aW9uICBvYmplY3QgdG8gbWVyZ2UgaW50b1xuICAgICAqQHBhcmFtIDxvYmplY3Q+IGRlc3RpbmF0aW9uICBvYmplY3QgdG8gbWVyZ2UgaW50b1xuICAgICAqQHBhcmFtIDxib29sZWFuPiBpc1N0cmljdE1vZGUgZGVmYXVsdCBmYWxzZSwgaWYgdHJ1ZSB3b3VsZCBnZW5lcmF0ZSBhbiBlcnJvciBpZiBpbm5lciBvYmplY3RzIGluIGFycmF5IGRvIG5vdCBoYXZlIGlkIGZpZWxkXG4gICAgICovXG4gICAgZnVuY3Rpb24gbWVyZ2VPYmplY3QoZGVzdGluYXRpb24sIHNvdXJjZSwgaXNTdHJpY3RNb2RlKSB7XG4gICAgICAgIGlmICghZGVzdGluYXRpb24pIHtcbiAgICAgICAgICAgIHJldHVybiBzb3VyY2U7Ly8gXy5hc3NpZ24oe30sIHNvdXJjZSk7O1xuICAgICAgICB9XG4gICAgICAgIC8vIGNyZWF0ZSBuZXcgb2JqZWN0IGNvbnRhaW5pbmcgb25seSB0aGUgcHJvcGVydGllcyBvZiBzb3VyY2UgbWVyZ2Ugd2l0aCBkZXN0aW5hdGlvblxuICAgICAgICB2YXIgb2JqZWN0ID0ge307XG4gICAgICAgIGZvciAodmFyIHByb3BlcnR5IGluIHNvdXJjZSkge1xuICAgICAgICAgICAgaWYgKF8uaXNBcnJheShzb3VyY2VbcHJvcGVydHldKSkge1xuICAgICAgICAgICAgICAgIG9iamVjdFtwcm9wZXJ0eV0gPSBtZXJnZUFycmF5KGRlc3RpbmF0aW9uW3Byb3BlcnR5XSwgc291cmNlW3Byb3BlcnR5XSwgaXNTdHJpY3RNb2RlKTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoXy5pc0Z1bmN0aW9uKHNvdXJjZVtwcm9wZXJ0eV0pKSB7XG4gICAgICAgICAgICAgICAgb2JqZWN0W3Byb3BlcnR5XSA9IHNvdXJjZVtwcm9wZXJ0eV07XG4gICAgICAgICAgICB9IGVsc2UgaWYgKF8uaXNPYmplY3Qoc291cmNlW3Byb3BlcnR5XSkpIHtcbiAgICAgICAgICAgICAgICBvYmplY3RbcHJvcGVydHldID0gbWVyZ2VPYmplY3QoZGVzdGluYXRpb25bcHJvcGVydHldLCBzb3VyY2VbcHJvcGVydHldLCBpc1N0cmljdE1vZGUpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBvYmplY3RbcHJvcGVydHldID0gc291cmNlW3Byb3BlcnR5XTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGNsZWFyT2JqZWN0KGRlc3RpbmF0aW9uKTtcbiAgICAgICAgXy5hc3NpZ24oZGVzdGluYXRpb24sIG9iamVjdCk7XG5cbiAgICAgICAgcmV0dXJuIGRlc3RpbmF0aW9uO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIG1lcmdlQXJyYXkoZGVzdGluYXRpb24sIHNvdXJjZSwgaXNTdHJpY3RNb2RlKSB7XG4gICAgICAgIGlmICghZGVzdGluYXRpb24pIHtcbiAgICAgICAgICAgIHJldHVybiBzb3VyY2U7XG4gICAgICAgIH1cbiAgICAgICAgdmFyIGFycmF5ID0gW107XG4gICAgICAgIHNvdXJjZS5mb3JFYWNoKGZ1bmN0aW9uIChpdGVtKSB7XG4gICAgICAgICAgICAvLyBvYmplY3QgaW4gYXJyYXkgbXVzdCBoYXZlIGFuIGlkIG90aGVyd2lzZSB3ZSBjYW4ndCBtYWludGFpbiB0aGUgaW5zdGFuY2UgcmVmZXJlbmNlXG4gICAgICAgICAgICBpZiAoIV8uaXNBcnJheShpdGVtKSAmJiBfLmlzT2JqZWN0KGl0ZW0pKSB7XG4gICAgICAgICAgICAgICAgLy8gbGV0IHRyeSB0byBmaW5kIHRoZSBpbnN0YW5jZVxuICAgICAgICAgICAgICAgIGlmIChhbmd1bGFyLmlzRGVmaW5lZChpdGVtLmlkKSkge1xuICAgICAgICAgICAgICAgICAgICBhcnJheS5wdXNoKG1lcmdlT2JqZWN0KF8uZmluZChkZXN0aW5hdGlvbiwgeyBpZDogaXRlbS5pZCB9KSwgaXRlbSwgaXNTdHJpY3RNb2RlKSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGlzU3RyaWN0TW9kZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdvYmplY3RzIGluIGFycmF5IG11c3QgaGF2ZSBhbiBpZCBvdGhlcndpc2Ugd2UgY2FuXFwndCBtYWludGFpbiB0aGUgaW5zdGFuY2UgcmVmZXJlbmNlLiAnICsgSlNPTi5zdHJpbmdpZnkoaXRlbSkpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIGFycmF5LnB1c2goaXRlbSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBhcnJheS5wdXNoKGl0ZW0pO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICBkZXN0aW5hdGlvbi5sZW5ndGggPSAwO1xuICAgICAgICBBcnJheS5wcm90b3R5cGUucHVzaC5hcHBseShkZXN0aW5hdGlvbiwgYXJyYXkpO1xuICAgICAgICAvL2FuZ3VsYXIuY29weShkZXN0aW5hdGlvbiwgYXJyYXkpO1xuICAgICAgICByZXR1cm4gZGVzdGluYXRpb247XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gY2xlYXJPYmplY3Qob2JqZWN0KSB7XG4gICAgICAgIE9iamVjdC5rZXlzKG9iamVjdCkuZm9yRWFjaChmdW5jdGlvbiAoa2V5KSB7IGRlbGV0ZSBvYmplY3Rba2V5XTsgfSk7XG4gICAgfVxufTtcbn0oKSk7XG5cbihmdW5jdGlvbigpIHtcblwidXNlIHN0cmljdFwiO1xuXG4vKipcbiAqIFxuICogU2VydmljZSB0aGF0IGFsbG93cyBhbiBhcnJheSBvZiBkYXRhIHJlbWFpbiBpbiBzeW5jIHdpdGggYmFja2VuZC5cbiAqIFxuICogXG4gKiBleDpcbiAqIHdoZW4gdGhlcmUgaXMgYSBub3RpZmljYXRpb24sIG5vdGljYXRpb25TZXJ2aWNlIG5vdGlmaWVzIHRoYXQgdGhlcmUgaXMgc29tZXRoaW5nIG5ldy4uLnRoZW4gdGhlIGRhdGFzZXQgZ2V0IHRoZSBkYXRhIGFuZCBub3RpZmllcyBhbGwgaXRzIGNhbGxiYWNrLlxuICogXG4gKiBOT1RFOiBcbiAqICBcbiAqIFxuICogUHJlLVJlcXVpc3RlOlxuICogLS0tLS0tLS0tLS0tLVxuICogU3luYyBkb2VzIG5vdCB3b3JrIGlmIG9iamVjdHMgZG8gbm90IGhhdmUgQk9USCBpZCBhbmQgcmV2aXNpb24gZmllbGQhISEhXG4gKiBcbiAqIFdoZW4gdGhlIGJhY2tlbmQgd3JpdGVzIGFueSBkYXRhIHRvIHRoZSBkYiB0aGF0IGFyZSBzdXBwb3NlZCB0byBiZSBzeW5jcm9uaXplZDpcbiAqIEl0IG11c3QgbWFrZSBzdXJlIGVhY2ggYWRkLCB1cGRhdGUsIHJlbW92YWwgb2YgcmVjb3JkIGlzIHRpbWVzdGFtcGVkLlxuICogSXQgbXVzdCBub3RpZnkgdGhlIGRhdGFzdHJlYW0gKHdpdGggbm90aWZ5Q2hhbmdlIG9yIG5vdGlmeVJlbW92YWwpIHdpdGggc29tZSBwYXJhbXMgc28gdGhhdCBiYWNrZW5kIGtub3dzIHRoYXQgaXQgaGFzIHRvIHB1c2ggYmFjayB0aGUgZGF0YSBiYWNrIHRvIHRoZSBzdWJzY3JpYmVycyAoZXg6IHRoZSB0YXNrQ3JlYXRpb24gd291bGQgbm90aWZ5IHdpdGggaXRzIHBsYW5JZClcbiogXG4gKiBcbiAqL1xuYW5ndWxhclxuICAgIC5tb2R1bGUoJ3N5bmMnKVxuICAgIC5wcm92aWRlcignJHN5bmMnLCBzeW5jUHJvdmlkZXIpO1xuXG5mdW5jdGlvbiBzeW5jUHJvdmlkZXIoKSB7XG5cbiAgICB2YXIgZGVidWc7XG5cbiAgICB0aGlzLnNldERlYnVnID0gZnVuY3Rpb24gKHZhbHVlKSB7XG4gICAgICAgIGRlYnVnID0gdmFsdWU7XG4gICAgfTtcblxuICAgIHRoaXMuJGdldCA9IGZ1bmN0aW9uIHN5bmMoJHJvb3RTY29wZSwgJHEsICRzb2NrZXRpbywgJHN5bmNHYXJiYWdlQ29sbGVjdG9yLCAkc3luY01lcmdlKSB7XG5cbiAgICAgICAgdmFyIHB1YmxpY2F0aW9uTGlzdGVuZXJzID0ge30sXG4gICAgICAgICAgICBwdWJsaWNhdGlvbkxpc3RlbmVyQ291bnQgPSAwO1xuICAgICAgICB2YXIgR1JBQ0VfUEVSSU9EX0lOX1NFQ09ORFMgPSA4O1xuICAgICAgICB2YXIgU1lOQ19WRVJTSU9OID0gJzEuMSc7XG5cblxuICAgICAgICBsaXN0ZW5Ub1N5bmNOb3RpZmljYXRpb24oKTtcblxuICAgICAgICB2YXIgc2VydmljZSA9IHtcbiAgICAgICAgICAgIHN1YnNjcmliZTogc3Vic2NyaWJlLFxuICAgICAgICAgICAgcmVzb2x2ZVN1YnNjcmlwdGlvbjogcmVzb2x2ZVN1YnNjcmlwdGlvbixcbiAgICAgICAgICAgIGdldEdyYWNlUGVyaW9kOiBnZXRHcmFjZVBlcmlvZFxuICAgICAgICB9O1xuXG4gICAgICAgIHJldHVybiBzZXJ2aWNlO1xuXG4gICAgICAgIC8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vXG4gICAgICAgIC8qKlxuICAgICAgICAgKiBzdWJzY3JpYmUgdG8gcHVibGljYXRpb24gYW5kIHJldHVybnMgdGhlIHN1YnNjcmlwdGlvbiB3aGVuIGRhdGEgaXMgYXZhaWxhYmxlLiBcbiAgICAgICAgICogQHBhcmFtIHB1YmxpY2F0aW9uIG5hbWUuIG9uIHRoZSBzZXJ2ZXIgc2lkZSwgYSBwdWJsaWNhdGlvbiBzaGFsbCBleGlzdC4gZXg6IG1hZ2F6aW5lcy5zeW5jXG4gICAgICAgICAqIEBwYXJhbSBwYXJhbXMgICB0aGUgcGFyYW1zIG9iamVjdCBwYXNzZWQgdG8gdGhlIHN1YnNjcmlwdGlvbiwgZXg6IHttYWdhemluZUlkOidlbnRyZXByZW5ldXInfSlcbiAgICAgICAgICogQHBhcmFtIG9iamVjdENsYXNzIGFuIGluc3RhbmNlIG9mIHRoaXMgY2xhc3Mgd2lsbCBiZSBjcmVhdGVkIGZvciBlYWNoIHJlY29yZCByZWNlaXZlZC5cbiAgICAgICAgICogcmV0dXJucyBhIHByb21pc2UgcmV0dXJuaW5nIHRoZSBzdWJzY3JpcHRpb24gd2hlbiB0aGUgZGF0YSBpcyBzeW5jZWRcbiAgICAgICAgICogb3IgcmVqZWN0cyBpZiB0aGUgaW5pdGlhbCBzeW5jIGZhaWxzIHRvIGNvbXBsZXRlIGluIGEgbGltaXRlZCBhbW91bnQgb2YgdGltZS4gXG4gICAgICAgICAqIFxuICAgICAgICAgKiB0byBnZXQgdGhlIGRhdGEgZnJvbSB0aGUgZGF0YVNldCwganVzdCBkYXRhU2V0LmdldERhdGEoKVxuICAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gcmVzb2x2ZVN1YnNjcmlwdGlvbihwdWJsaWNhdGlvbk5hbWUsIHBhcmFtcywgb2JqZWN0Q2xhc3MpIHtcbiAgICAgICAgICAgIHZhciBkZWZlcnJlZCA9ICRxLmRlZmVyKCk7XG4gICAgICAgICAgICB2YXIgc0RzID0gc3Vic2NyaWJlKHB1YmxpY2F0aW9uTmFtZSkuc2V0T2JqZWN0Q2xhc3Mob2JqZWN0Q2xhc3MpO1xuXG4gICAgICAgICAgICAvLyBnaXZlIGEgbGl0dGxlIHRpbWUgZm9yIHN1YnNjcmlwdGlvbiB0byBmZXRjaCB0aGUgZGF0YS4uLm90aGVyd2lzZSBnaXZlIHVwIHNvIHRoYXQgd2UgZG9uJ3QgZ2V0IHN0dWNrIGluIGEgcmVzb2x2ZSB3YWl0aW5nIGZvcmV2ZXIuXG4gICAgICAgICAgICB2YXIgZ3JhY2VQZXJpb2QgPSBzZXRUaW1lb3V0KGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICBpZiAoIXNEcy5yZWFkeSkge1xuICAgICAgICAgICAgICAgICAgICBzRHMuZGVzdHJveSgpO1xuICAgICAgICAgICAgICAgICAgICBsb2dJbmZvKCdBdHRlbXB0IHRvIHN1YnNjcmliZSB0byBwdWJsaWNhdGlvbiAnICsgcHVibGljYXRpb25OYW1lICsgJyBmYWlsZWQnKTtcbiAgICAgICAgICAgICAgICAgICAgZGVmZXJyZWQucmVqZWN0KCdTWU5DX1RJTUVPVVQnKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9LCBHUkFDRV9QRVJJT0RfSU5fU0VDT05EUyAqIDEwMDApO1xuXG4gICAgICAgICAgICBzRHMuc2V0UGFyYW1ldGVycyhwYXJhbXMpXG4gICAgICAgICAgICAgICAgLndhaXRGb3JEYXRhUmVhZHkoKVxuICAgICAgICAgICAgICAgIC50aGVuKGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICAgICAgY2xlYXJUaW1lb3V0KGdyYWNlUGVyaW9kKTtcbiAgICAgICAgICAgICAgICAgICAgZGVmZXJyZWQucmVzb2x2ZShzRHMpO1xuICAgICAgICAgICAgICAgIH0pLmNhdGNoKGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICAgICAgY2xlYXJUaW1lb3V0KGdyYWNlUGVyaW9kKTtcbiAgICAgICAgICAgICAgICAgICAgc0RzLmRlc3Ryb3koKTtcbiAgICAgICAgICAgICAgICAgICAgZGVmZXJyZWQucmVqZWN0KCdGYWlsZWQgdG8gc3Vic2NyaWJlIHRvIHB1YmxpY2F0aW9uICcgKyBwdWJsaWNhdGlvbk5hbWUgKyAnIGZhaWxlZCcpO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgcmV0dXJuIGRlZmVycmVkLnByb21pc2U7XG4gICAgICAgIH1cblxuICAgICAgICAvKipcbiAgICAgICAgICogXG4gICAgICAgICAqIGZvciB0ZXN0IHB1cnBvc2VzLCByZXR1cm5zIHRoZSB0aW1lIHJlc29sdmVTdWJzY3JpcHRpb24gYmVmb3JlIGl0IHRpbWVzIG91dC5cbiAgICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIGdldEdyYWNlUGVyaW9kKCkge1xuICAgICAgICAgICAgcmV0dXJuIEdSQUNFX1BFUklPRF9JTl9TRUNPTkRTO1xuICAgICAgICB9XG4gICAgICAgIC8qKlxuICAgICAgICAgKiBzdWJzY3JpYmUgdG8gcHVibGljYXRpb24uIEl0IHdpbGwgbm90IHN5bmMgdW50aWwgeW91IHNldCB0aGUgcGFyYW1zLlxuICAgICAgICAgKiBcbiAgICAgICAgICogQHBhcmFtIHB1YmxpY2F0aW9uIG5hbWUuIG9uIHRoZSBzZXJ2ZXIgc2lkZSwgYSBwdWJsaWNhdGlvbiBzaGFsbCBleGlzdC4gZXg6IG1hZ2F6aW5lcy5zeW5jXG4gICAgICAgICAqIEBwYXJhbSBwYXJhbXMgICB0aGUgcGFyYW1zIG9iamVjdCBwYXNzZWQgdG8gdGhlIHN1YnNjcmlwdGlvbiwgZXg6IHttYWdhemluZUlkOidlbnRyZXByZW5ldXInfSlcbiAgICAgICAgICogcmV0dXJucyBzdWJzY3JpcHRpb25cbiAgICAgICAgICogXG4gICAgICAgICAqL1xuICAgICAgICBmdW5jdGlvbiBzdWJzY3JpYmUocHVibGljYXRpb25OYW1lLCBzY29wZSkge1xuICAgICAgICAgICAgcmV0dXJuIG5ldyBTdWJzY3JpcHRpb24ocHVibGljYXRpb25OYW1lLCBzY29wZSk7XG4gICAgICAgIH1cblxuXG5cbiAgICAgICAgLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy9cbiAgICAgICAgLy8gSEVMUEVSU1xuXG4gICAgICAgIC8vIGV2ZXJ5IHN5bmMgbm90aWZpY2F0aW9uIGNvbWVzIHRocnUgdGhlIHNhbWUgZXZlbnQgdGhlbiBpdCBpcyBkaXNwYXRjaGVzIHRvIHRoZSB0YXJnZXRlZCBzdWJzY3JpcHRpb25zLlxuICAgICAgICBmdW5jdGlvbiBsaXN0ZW5Ub1N5bmNOb3RpZmljYXRpb24oKSB7XG4gICAgICAgICAgICAkc29ja2V0aW8ub24oJ1NZTkNfTk9XJywgZnVuY3Rpb24gKHN1Yk5vdGlmaWNhdGlvbiwgZm4pIHtcbiAgICAgICAgICAgICAgICBsb2dJbmZvKCdTeW5jaW5nIHdpdGggc3Vic2NyaXB0aW9uIFtuYW1lOicgKyBzdWJOb3RpZmljYXRpb24ubmFtZSArICcsIGlkOicgKyBzdWJOb3RpZmljYXRpb24uc3Vic2NyaXB0aW9uSWQgKyAnICwgcGFyYW1zOicgKyBKU09OLnN0cmluZ2lmeShzdWJOb3RpZmljYXRpb24ucGFyYW1zKSArICddLiBSZWNvcmRzOicgKyBzdWJOb3RpZmljYXRpb24ucmVjb3Jkcy5sZW5ndGggKyAnWycgKyAoc3ViTm90aWZpY2F0aW9uLmRpZmYgPyAnRGlmZicgOiAnQWxsJykgKyAnXScpO1xuICAgICAgICAgICAgICAgIHZhciBsaXN0ZW5lcnMgPSBwdWJsaWNhdGlvbkxpc3RlbmVyc1tzdWJOb3RpZmljYXRpb24ubmFtZV07XG4gICAgICAgICAgICAgICAgaWYgKGxpc3RlbmVycykge1xuICAgICAgICAgICAgICAgICAgICBmb3IgKHZhciBsaXN0ZW5lciBpbiBsaXN0ZW5lcnMpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxpc3RlbmVyc1tsaXN0ZW5lcl0oc3ViTm90aWZpY2F0aW9uKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBmbignU1lOQ0VEJyk7IC8vIGxldCBrbm93IHRoZSBiYWNrZW5kIHRoZSBjbGllbnQgd2FzIGFibGUgdG8gc3luYy5cbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9O1xuXG5cbiAgICAgICAgLy8gdGhpcyBhbGxvd3MgYSBkYXRhc2V0IHRvIGxpc3RlbiB0byBhbnkgU1lOQ19OT1cgZXZlbnQuLmFuZCBpZiB0aGUgbm90aWZpY2F0aW9uIGlzIGFib3V0IGl0cyBkYXRhLlxuICAgICAgICBmdW5jdGlvbiBhZGRQdWJsaWNhdGlvbkxpc3RlbmVyKHN0cmVhbU5hbWUsIGNhbGxiYWNrKSB7XG4gICAgICAgICAgICB2YXIgdWlkID0gcHVibGljYXRpb25MaXN0ZW5lckNvdW50Kys7XG4gICAgICAgICAgICB2YXIgbGlzdGVuZXJzID0gcHVibGljYXRpb25MaXN0ZW5lcnNbc3RyZWFtTmFtZV07XG4gICAgICAgICAgICBpZiAoIWxpc3RlbmVycykge1xuICAgICAgICAgICAgICAgIHB1YmxpY2F0aW9uTGlzdGVuZXJzW3N0cmVhbU5hbWVdID0gbGlzdGVuZXJzID0ge307XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBsaXN0ZW5lcnNbdWlkXSA9IGNhbGxiYWNrO1xuXG4gICAgICAgICAgICByZXR1cm4gZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgIGRlbGV0ZSBsaXN0ZW5lcnNbdWlkXTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAgICAgLy8gU3Vic2NyaXB0aW9uIG9iamVjdFxuICAgICAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAgICAgLyoqXG4gICAgICAgICAqIGEgc3Vic2NyaXB0aW9uIHN5bmNocm9uaXplcyB3aXRoIHRoZSBiYWNrZW5kIGZvciBhbnkgYmFja2VuZCBkYXRhIGNoYW5nZSBhbmQgbWFrZXMgdGhhdCBkYXRhIGF2YWlsYWJsZSB0byBhIGNvbnRyb2xsZXIuXG4gICAgICAgICAqIFxuICAgICAgICAgKiAgV2hlbiBjbGllbnQgc3Vic2NyaWJlcyB0byBhbiBzeW5jcm9uaXplZCBhcGksIGFueSBkYXRhIGNoYW5nZSB0aGF0IGltcGFjdHMgdGhlIGFwaSByZXN1bHQgV0lMTCBiZSBQVVNIZWQgdG8gdGhlIGNsaWVudC5cbiAgICAgICAgICogSWYgdGhlIGNsaWVudCBkb2VzIE5PVCBzdWJzY3JpYmUgb3Igc3RvcCBzdWJzY3JpYmUsIGl0IHdpbGwgbm8gbG9uZ2VyIHJlY2VpdmUgdGhlIFBVU0guIFxuICAgICAgICAgKiAgICBcbiAgICAgICAgICogaWYgdGhlIGNvbm5lY3Rpb24gaXMgbG9zdCBmb3IgYSBzaG9ydCB0aW1lIChkdXJhdGlvbiBkZWZpbmVkIG9uIHNlcnZlci1zaWRlKSwgdGhlIHNlcnZlciBxdWV1ZXMgdGhlIGNoYW5nZXMgaWYgYW55LiBcbiAgICAgICAgICogV2hlbiB0aGUgY29ubmVjdGlvbiByZXR1cm5zLCB0aGUgbWlzc2luZyBkYXRhIGF1dG9tYXRpY2FsbHkgIHdpbGwgYmUgUFVTSGVkIHRvIHRoZSBzdWJzY3JpYmluZyBjbGllbnQuXG4gICAgICAgICAqIGlmIHRoZSBjb25uZWN0aW9uIGlzIGxvc3QgZm9yIGEgbG9uZyB0aW1lIChkdXJhdGlvbiBkZWZpbmVkIG9uIHRoZSBzZXJ2ZXIpLCB0aGUgc2VydmVyIHdpbGwgZGVzdHJveSB0aGUgc3Vic2NyaXB0aW9uLiBUbyBzaW1wbGlmeSwgdGhlIGNsaWVudCB3aWxsIHJlc3Vic2NyaWJlIGF0IGl0cyByZWNvbm5lY3Rpb24gYW5kIGdldCBhbGwgZGF0YS5cbiAgICAgICAgICogXG4gICAgICAgICAqIHN1YnNjcmlwdGlvbiBvYmplY3QgcHJvdmlkZXMgMyBjYWxsYmFja3MgKGFkZCx1cGRhdGUsIGRlbCkgd2hpY2ggYXJlIGNhbGxlZCBkdXJpbmcgc3luY2hyb25pemF0aW9uLlxuICAgICAgICAgKiAgICAgIFxuICAgICAgICAgKiBTY29wZSB3aWxsIGFsbG93IHRoZSBzdWJzY3JpcHRpb24gc3RvcCBzeW5jaHJvbml6aW5nIGFuZCBjYW5jZWwgcmVnaXN0cmF0aW9uIHdoZW4gaXQgaXMgZGVzdHJveWVkLiBcbiAgICAgICAgICogIFxuICAgICAgICAgKiBDb25zdHJ1Y3RvcjpcbiAgICAgICAgICogXG4gICAgICAgICAqIEBwYXJhbSBwdWJsaWNhdGlvbiwgdGhlIHB1YmxpY2F0aW9uIG11c3QgZXhpc3Qgb24gdGhlIHNlcnZlciBzaWRlXG4gICAgICAgICAqIEBwYXJhbSBzY29wZSwgYnkgZGVmYXVsdCAkcm9vdFNjb3BlLCBidXQgY2FuIGJlIG1vZGlmaWVkIGxhdGVyIG9uIHdpdGggYXR0YWNoIG1ldGhvZC5cbiAgICAgICAgICovXG5cbiAgICAgICAgZnVuY3Rpb24gU3Vic2NyaXB0aW9uKHB1YmxpY2F0aW9uLCBzY29wZSkge1xuICAgICAgICAgICAgdmFyIHRpbWVzdGFtcEZpZWxkLCBpc1N5bmNpbmdPbiA9IGZhbHNlLCBpc1NpbmdsZSwgdXBkYXRlRGF0YVN0b3JhZ2UsIGNhY2hlLCBpc0luaXRpYWxQdXNoQ29tcGxldGVkLCBkZWZlcnJlZEluaXRpYWxpemF0aW9uLCBzdHJpY3RNb2RlO1xuICAgICAgICAgICAgdmFyIG9uUmVhZHlPZmYsIGZvcm1hdFJlY29yZDtcbiAgICAgICAgICAgIHZhciByZWNvbm5lY3RPZmYsIHB1YmxpY2F0aW9uTGlzdGVuZXJPZmYsIGRlc3Ryb3lPZmY7XG4gICAgICAgICAgICB2YXIgb2JqZWN0Q2xhc3M7XG4gICAgICAgICAgICB2YXIgc3Vic2NyaXB0aW9uSWQ7XG5cbiAgICAgICAgICAgIHZhciBzRHMgPSB0aGlzO1xuICAgICAgICAgICAgdmFyIHN1YlBhcmFtcyA9IHt9O1xuICAgICAgICAgICAgdmFyIHJlY29yZFN0YXRlcyA9IHt9O1xuICAgICAgICAgICAgdmFyIGlubmVyU2NvcGU7Ly89ICRyb290U2NvcGUuJG5ldyh0cnVlKTtcbiAgICAgICAgICAgIHZhciBzeW5jTGlzdGVuZXIgPSBuZXcgU3luY0xpc3RlbmVyKCk7XG5cblxuICAgICAgICAgICAgdGhpcy5yZWFkeSA9IGZhbHNlO1xuICAgICAgICAgICAgdGhpcy5zeW5jT24gPSBzeW5jT247XG4gICAgICAgICAgICB0aGlzLnN5bmNPZmYgPSBzeW5jT2ZmO1xuICAgICAgICAgICAgdGhpcy5zZXRPblJlYWR5ID0gc2V0T25SZWFkeTtcblxuICAgICAgICAgICAgdGhpcy5vblJlYWR5ID0gb25SZWFkeTtcbiAgICAgICAgICAgIHRoaXMub25VcGRhdGUgPSBvblVwZGF0ZTtcbiAgICAgICAgICAgIHRoaXMub25BZGQgPSBvbkFkZDtcbiAgICAgICAgICAgIHRoaXMub25SZW1vdmUgPSBvblJlbW92ZTtcblxuICAgICAgICAgICAgdGhpcy5nZXREYXRhID0gZ2V0RGF0YTtcbiAgICAgICAgICAgIHRoaXMuc2V0UGFyYW1ldGVycyA9IHNldFBhcmFtZXRlcnM7XG5cbiAgICAgICAgICAgIHRoaXMud2FpdEZvckRhdGFSZWFkeSA9IHdhaXRGb3JEYXRhUmVhZHk7XG4gICAgICAgICAgICB0aGlzLndhaXRGb3JTdWJzY3JpcHRpb25SZWFkeSA9IHdhaXRGb3JTdWJzY3JpcHRpb25SZWFkeTtcblxuICAgICAgICAgICAgdGhpcy5zZXRGb3JjZSA9IHNldEZvcmNlO1xuICAgICAgICAgICAgdGhpcy5pc1N5bmNpbmcgPSBpc1N5bmNpbmc7XG4gICAgICAgICAgICB0aGlzLmlzUmVhZHkgPSBpc1JlYWR5O1xuXG4gICAgICAgICAgICB0aGlzLnNldFNpbmdsZSA9IHNldFNpbmdsZTtcblxuICAgICAgICAgICAgdGhpcy5zZXRPYmplY3RDbGFzcyA9IHNldE9iamVjdENsYXNzO1xuICAgICAgICAgICAgdGhpcy5nZXRPYmplY3RDbGFzcyA9IGdldE9iamVjdENsYXNzO1xuXG4gICAgICAgICAgICB0aGlzLnNldFN0cmljdE1vZGUgPSBzZXRTdHJpY3RNb2RlO1xuXG4gICAgICAgICAgICB0aGlzLmF0dGFjaCA9IGF0dGFjaDtcbiAgICAgICAgICAgIHRoaXMuZGVzdHJveSA9IGRlc3Ryb3k7XG5cbiAgICAgICAgICAgIHRoaXMuaXNFeGlzdGluZ1N0YXRlRm9yID0gaXNFeGlzdGluZ1N0YXRlRm9yOyAvLyBmb3IgdGVzdGluZyBwdXJwb3Nlc1xuXG4gICAgICAgICAgICBzZXRTaW5nbGUoZmFsc2UpO1xuXG4gICAgICAgICAgICAvLyB0aGlzIHdpbGwgbWFrZSBzdXJlIHRoYXQgdGhlIHN1YnNjcmlwdGlvbiBpcyByZWxlYXNlZCBmcm9tIHNlcnZlcnMgaWYgdGhlIGFwcCBjbG9zZXMgKGNsb3NlIGJyb3dzZXIsIHJlZnJlc2guLi4pXG4gICAgICAgICAgICBhdHRhY2goc2NvcGUgfHwgJHJvb3RTY29wZSk7XG5cbiAgICAgICAgICAgIC8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy9cblxuICAgICAgICAgICAgZnVuY3Rpb24gZGVzdHJveSgpIHtcbiAgICAgICAgICAgICAgICBzeW5jT2ZmKCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKiB0aGlzIHdpbGwgYmUgY2FsbGVkIHdoZW4gZGF0YSBpcyBhdmFpbGFibGUgXG4gICAgICAgICAgICAgKiAgaXQgbWVhbnMgcmlnaHQgYWZ0ZXIgZWFjaCBzeW5jIVxuICAgICAgICAgICAgICogXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBzZXRPblJlYWR5KGNhbGxiYWNrKSB7XG4gICAgICAgICAgICAgICAgaWYgKG9uUmVhZHlPZmYpIHtcbiAgICAgICAgICAgICAgICAgICAgb25SZWFkeU9mZigpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBvblJlYWR5T2ZmID0gb25SZWFkeShjYWxsYmFjayk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgKiBmb3JjZSByZXN5bmNpbmcgZnJvbSBzY3JhdGNoIGV2ZW4gaWYgdGhlIHBhcmFtZXRlcnMgaGF2ZSBub3QgY2hhbmdlZFxuICAgICAgICAgICAgICogXG4gICAgICAgICAgICAgKiBpZiBvdXRzaWRlIGNvZGUgaGFzIG1vZGlmaWVkIHRoZSBkYXRhIGFuZCB5b3UgbmVlZCB0byByb2xsYmFjaywgeW91IGNvdWxkIGNvbnNpZGVyIGZvcmNpbmcgYSByZWZyZXNoIHdpdGggdGhpcy4gQmV0dGVyIHNvbHV0aW9uIHNob3VsZCBiZSBmb3VuZCB0aGFuIHRoYXQuXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICAqL1xuICAgICAgICAgICAgZnVuY3Rpb24gc2V0Rm9yY2UodmFsdWUpIHtcbiAgICAgICAgICAgICAgICBpZiAodmFsdWUpIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gcXVpY2sgaGFjayB0byBmb3JjZSB0byByZWxvYWQuLi5yZWNvZGUgbGF0ZXIuXG4gICAgICAgICAgICAgICAgICAgIHNEcy5zeW5jT2ZmKCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogaWYgc2V0IHRvIHRydWUsIGlmIGFuIG9iamVjdCB3aXRoaW4gYW4gYXJyYXkgcHJvcGVydHkgb2YgdGhlIHJlY29yZCB0byBzeW5jIGhhcyBubyBJRCBmaWVsZC5cbiAgICAgICAgICAgICAqIGFuIGVycm9yIHdvdWxkIGJlIHRocm93bi5cbiAgICAgICAgICAgICAqIEl0IGlzIGltcG9ydGFudCBpZiB3ZSB3YW50IHRvIGJlIGFibGUgdG8gbWFpbnRhaW4gaW5zdGFuY2UgcmVmZXJlbmNlcyBldmVuIGZvciB0aGUgb2JqZWN0cyBpbnNpZGUgYXJyYXlzLlxuICAgICAgICAgICAgICpcbiAgICAgICAgICAgICAqIEZvcmNlcyB1cyB0byB1c2UgaWQgZXZlcnkgd2hlcmUuXG4gICAgICAgICAgICAgKlxuICAgICAgICAgICAgICogU2hvdWxkIGJlIHRoZSBkZWZhdWx0Li4uYnV0IHRvbyByZXN0cmljdGl2ZSBmb3Igbm93LlxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBzZXRTdHJpY3RNb2RlKHZhbHVlKSB7XG4gICAgICAgICAgICAgICAgc3RyaWN0TW9kZSA9IHRydWU7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogVGhlIGZvbGxvd2luZyBvYmplY3Qgd2lsbCBiZSBidWlsdCB1cG9uIGVhY2ggcmVjb3JkIHJlY2VpdmVkIGZyb20gdGhlIGJhY2tlbmRcbiAgICAgICAgICAgICAqIFxuICAgICAgICAgICAgICogVGhpcyBjYW5ub3QgYmUgbW9kaWZpZWQgYWZ0ZXIgdGhlIHN5bmMgaGFzIHN0YXJ0ZWQuXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICAqIEBwYXJhbSBjbGFzc1ZhbHVlXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIHNldE9iamVjdENsYXNzKGNsYXNzVmFsdWUpIHtcbiAgICAgICAgICAgICAgICBpZiAoZGVmZXJyZWRJbml0aWFsaXphdGlvbikge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIG9iamVjdENsYXNzID0gY2xhc3NWYWx1ZTtcbiAgICAgICAgICAgICAgICBmb3JtYXRSZWNvcmQgPSBmdW5jdGlvbiAocmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBuZXcgb2JqZWN0Q2xhc3MocmVjb3JkKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgc2V0U2luZ2xlKGlzU2luZ2xlKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBnZXRPYmplY3RDbGFzcygpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gb2JqZWN0Q2xhc3M7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogdGhpcyBmdW5jdGlvbiBzdGFydHMgdGhlIHN5bmNpbmcuXG4gICAgICAgICAgICAgKiBPbmx5IHB1YmxpY2F0aW9uIHB1c2hpbmcgZGF0YSBtYXRjaGluZyBvdXIgZmV0Y2hpbmcgcGFyYW1zIHdpbGwgYmUgcmVjZWl2ZWQuXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICAqIGV4OiBmb3IgYSBwdWJsaWNhdGlvbiBuYW1lZCBcIm1hZ2F6aW5lcy5zeW5jXCIsIGlmIGZldGNoaW5nIHBhcmFtcyBlcXVhbGxlZCB7bWFnYXppbk5hbWU6J2NhcnMnfSwgdGhlIG1hZ2F6aW5lIGNhcnMgZGF0YSB3b3VsZCBiZSByZWNlaXZlZCBieSB0aGlzIHN1YnNjcmlwdGlvbi5cbiAgICAgICAgICAgICAqIFxuICAgICAgICAgICAgICogQHBhcmFtIGZldGNoaW5nUGFyYW1zXG4gICAgICAgICAgICAgKiBAcGFyYW0gb3B0aW9uc1xuICAgICAgICAgICAgICogXG4gICAgICAgICAgICAgKiBAcmV0dXJucyBhIHByb21pc2UgdGhhdCByZXNvbHZlcyB3aGVuIGRhdGEgaXMgYXJyaXZlZC5cbiAgICAgICAgICAgICAqL1xuICAgICAgICAgICAgZnVuY3Rpb24gc2V0UGFyYW1ldGVycyhmZXRjaGluZ1BhcmFtcywgb3B0aW9ucykge1xuICAgICAgICAgICAgICAgIGlmIChpc1N5bmNpbmdPbiAmJiBhbmd1bGFyLmVxdWFscyhmZXRjaGluZ1BhcmFtcywgc3ViUGFyYW1zKSkge1xuICAgICAgICAgICAgICAgICAgICAvLyBpZiB0aGUgcGFyYW1zIGhhdmUgbm90IGNoYW5nZWQsIGp1c3QgcmV0dXJucyB3aXRoIGN1cnJlbnQgZGF0YS5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHNEczsgLy8kcS5yZXNvbHZlKGdldERhdGEoKSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHN5bmNPZmYoKTtcbiAgICAgICAgICAgICAgICBpZiAoIWlzU2luZ2xlKSB7XG4gICAgICAgICAgICAgICAgICAgIGNhY2hlLmxlbmd0aCA9IDA7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgc3ViUGFyYW1zID0gZmV0Y2hpbmdQYXJhbXMgfHwge307XG4gICAgICAgICAgICAgICAgb3B0aW9ucyA9IG9wdGlvbnMgfHwge307XG4gICAgICAgICAgICAgICAgaWYgKGFuZ3VsYXIuaXNEZWZpbmVkKG9wdGlvbnMuc2luZ2xlKSkge1xuICAgICAgICAgICAgICAgICAgICBzZXRTaW5nbGUob3B0aW9ucy5zaW5nbGUpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBzeW5jT24oKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyB3YWl0IGZvciB0aGUgaW5pdGlhbCBmZXRjaCB0byBjb21wbGV0ZSB0aGVuIHJldHVybnMgdGhpcyBzdWJzY3JpcHRpb25cbiAgICAgICAgICAgIGZ1bmN0aW9uIHdhaXRGb3JTdWJzY3JpcHRpb25SZWFkeSgpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZGVmZXJyZWRJbml0aWFsaXphdGlvbi5wcm9taXNlLnRoZW4oZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyB3YWl0IGZvciB0aGUgaW5pdGlhbCBmZXRjaCB0byBjb21wbGV0ZSB0aGVuIHJldHVybnMgdGhlIGRhdGFcbiAgICAgICAgICAgIGZ1bmN0aW9uIHdhaXRGb3JEYXRhUmVhZHkoKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGRlZmVycmVkSW5pdGlhbGl6YXRpb24ucHJvbWlzZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy8gZG9lcyB0aGUgZGF0YXNldCByZXR1cm5zIG9ubHkgb25lIG9iamVjdD8gbm90IGFuIGFycmF5P1xuICAgICAgICAgICAgZnVuY3Rpb24gc2V0U2luZ2xlKHZhbHVlKSB7XG4gICAgICAgICAgICAgICAgaWYgKGRlZmVycmVkSW5pdGlhbGl6YXRpb24pIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICB2YXIgdXBkYXRlRm47XG4gICAgICAgICAgICAgICAgaXNTaW5nbGUgPSB2YWx1ZTtcbiAgICAgICAgICAgICAgICBpZiAodmFsdWUpIHtcbiAgICAgICAgICAgICAgICAgICAgdXBkYXRlRm4gPSB1cGRhdGVTeW5jZWRPYmplY3Q7XG4gICAgICAgICAgICAgICAgICAgIGNhY2hlID0gb2JqZWN0Q2xhc3MgPyBuZXcgb2JqZWN0Q2xhc3Moe30pIDoge307XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgdXBkYXRlRm4gPSB1cGRhdGVTeW5jZWRBcnJheTtcbiAgICAgICAgICAgICAgICAgICAgY2FjaGUgPSBbXTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICB1cGRhdGVEYXRhU3RvcmFnZSA9IGZ1bmN0aW9uIChyZWNvcmQpIHtcbiAgICAgICAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHVwZGF0ZUZuKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGUubWVzc2FnZSA9ICdSZWNlaXZlZCBJbnZhbGlkIG9iamVjdCBmcm9tIHB1YmxpY2F0aW9uIFsnICsgcHVibGljYXRpb24gKyAnXTogJyArIEpTT04uc3RyaW5naWZ5KHJlY29yZCkgKyAnLiBERVRBSUxTOiAnICsgZS5tZXNzYWdlO1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgZTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIHJldHVybnMgdGhlIG9iamVjdCBvciBhcnJheSBpbiBzeW5jXG4gICAgICAgICAgICBmdW5jdGlvbiBnZXREYXRhKCkge1xuICAgICAgICAgICAgICAgIHJldHVybiBjYWNoZTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgKiB0aGUgZGF0YXNldCB3aWxsIHN0YXJ0IGxpc3RlbmluZyB0byB0aGUgZGF0YXN0cmVhbSBcbiAgICAgICAgICAgICAqIFxuICAgICAgICAgICAgICogTm90ZSBEdXJpbmcgdGhlIHN5bmMsIGl0IHdpbGwgYWxzbyBjYWxsIHRoZSBvcHRpb25hbCBjYWxsYmFja3MgLSBhZnRlciBwcm9jZXNzaW5nIEVBQ0ggcmVjb3JkIHJlY2VpdmVkLlxuICAgICAgICAgICAgICogXG4gICAgICAgICAgICAgKiBAcmV0dXJucyBhIHByb21pc2UgdGhhdCB3aWxsIGJlIHJlc29sdmVkIHdoZW4gdGhlIGRhdGEgaXMgcmVhZHkuXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIHN5bmNPbigpIHtcbiAgICAgICAgICAgICAgICBpZiAoaXNTeW5jaW5nT24pIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGRlZmVycmVkSW5pdGlhbGl6YXRpb24ucHJvbWlzZTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgZGVmZXJyZWRJbml0aWFsaXphdGlvbiA9ICRxLmRlZmVyKCk7XG4gICAgICAgICAgICAgICAgaXNJbml0aWFsUHVzaENvbXBsZXRlZCA9IGZhbHNlO1xuICAgICAgICAgICAgICAgIGxvZ0luZm8oJ1N5bmMgJyArIHB1YmxpY2F0aW9uICsgJyBvbi4gUGFyYW1zOicgKyBKU09OLnN0cmluZ2lmeShzdWJQYXJhbXMpKTtcbiAgICAgICAgICAgICAgICBpc1N5bmNpbmdPbiA9IHRydWU7XG4gICAgICAgICAgICAgICAgcmVnaXN0ZXJTdWJzY3JpcHRpb24oKTtcbiAgICAgICAgICAgICAgICByZWFkeUZvckxpc3RlbmluZygpO1xuICAgICAgICAgICAgICAgIHJldHVybiBkZWZlcnJlZEluaXRpYWxpemF0aW9uLnByb21pc2U7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogdGhlIGRhdGFzZXQgaXMgbm8gbG9uZ2VyIGxpc3RlbmluZyBhbmQgd2lsbCBub3QgY2FsbCBhbnkgY2FsbGJhY2tcbiAgICAgICAgICAgICAqL1xuICAgICAgICAgICAgZnVuY3Rpb24gc3luY09mZigpIHtcbiAgICAgICAgICAgICAgICBpZiAoZGVmZXJyZWRJbml0aWFsaXphdGlvbikge1xuICAgICAgICAgICAgICAgICAgICAvLyBpZiB0aGVyZSBpcyBjb2RlIHdhaXRpbmcgb24gdGhpcyBwcm9taXNlLi4gZXggKGxvYWQgaW4gcmVzb2x2ZSlcbiAgICAgICAgICAgICAgICAgICAgZGVmZXJyZWRJbml0aWFsaXphdGlvbi5yZXNvbHZlKGdldERhdGEoKSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGlmIChpc1N5bmNpbmdPbikge1xuICAgICAgICAgICAgICAgICAgICB1bnJlZ2lzdGVyU3Vic2NyaXB0aW9uKCk7XG4gICAgICAgICAgICAgICAgICAgIGlzU3luY2luZ09uID0gZmFsc2U7XG5cbiAgICAgICAgICAgICAgICAgICAgbG9nSW5mbygnU3luYyAnICsgcHVibGljYXRpb24gKyAnIG9mZi4gUGFyYW1zOicgKyBKU09OLnN0cmluZ2lmeShzdWJQYXJhbXMpKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHB1YmxpY2F0aW9uTGlzdGVuZXJPZmYpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHB1YmxpY2F0aW9uTGlzdGVuZXJPZmYoKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHB1YmxpY2F0aW9uTGlzdGVuZXJPZmYgPSBudWxsO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIGlmIChyZWNvbm5lY3RPZmYpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJlY29ubmVjdE9mZigpO1xuICAgICAgICAgICAgICAgICAgICAgICAgcmVjb25uZWN0T2ZmID0gbnVsbDtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gaXNTeW5jaW5nKCkge1xuICAgICAgICAgICAgICAgIHJldHVybiBpc1N5bmNpbmdPbjtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gcmVhZHlGb3JMaXN0ZW5pbmcoKSB7XG4gICAgICAgICAgICAgICAgaWYgKCFwdWJsaWNhdGlvbkxpc3RlbmVyT2ZmKSB7XG4gICAgICAgICAgICAgICAgICAgIGxpc3RlbkZvclJlY29ubmVjdGlvblRvUmVzeW5jKCk7XG4gICAgICAgICAgICAgICAgICAgIGxpc3RlblRvUHVibGljYXRpb24oKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogIEJ5IGRlZmF1bHQgdGhlIHJvb3RzY29wZSBpcyBhdHRhY2hlZCBpZiBubyBzY29wZSB3YXMgcHJvdmlkZWQuIEJ1dCBpdCBpcyBwb3NzaWJsZSB0byByZS1hdHRhY2ggaXQgdG8gYSBkaWZmZXJlbnQgc2NvcGUuIGlmIHRoZSBzdWJzY3JpcHRpb24gZGVwZW5kcyBvbiBhIGNvbnRyb2xsZXIuXG4gICAgICAgICAgICAgKlxuICAgICAgICAgICAgICogIERvIG5vdCBhdHRhY2ggYWZ0ZXIgaXQgaGFzIHN5bmNlZC5cbiAgICAgICAgICAgICAqL1xuICAgICAgICAgICAgZnVuY3Rpb24gYXR0YWNoKG5ld1Njb3BlKSB7XG4gICAgICAgICAgICAgICAgaWYgKGRlZmVycmVkSW5pdGlhbGl6YXRpb24pIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgaWYgKGRlc3Ryb3lPZmYpIHtcbiAgICAgICAgICAgICAgICAgICAgZGVzdHJveU9mZigpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBpbm5lclNjb3BlID0gbmV3U2NvcGU7XG4gICAgICAgICAgICAgICAgZGVzdHJveU9mZiA9IGlubmVyU2NvcGUuJG9uKCckZGVzdHJveScsIGRlc3Ryb3kpO1xuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gbGlzdGVuRm9yUmVjb25uZWN0aW9uVG9SZXN5bmMobGlzdGVuTm93KSB7XG4gICAgICAgICAgICAgICAgLy8gZ2l2ZSBhIGNoYW5jZSB0byBjb25uZWN0IGJlZm9yZSBsaXN0ZW5pbmcgdG8gcmVjb25uZWN0aW9uLi4uIEBUT0RPIHNob3VsZCBoYXZlIHVzZXJfcmVjb25uZWN0ZWRfZXZlbnRcbiAgICAgICAgICAgICAgICBzZXRUaW1lb3V0KGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICAgICAgcmVjb25uZWN0T2ZmID0gaW5uZXJTY29wZS4kb24oJ3VzZXJfY29ubmVjdGVkJywgZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgbG9nRGVidWcoJ1Jlc3luY2luZyBhZnRlciBuZXR3b3JrIGxvc3MgdG8gJyArIHB1YmxpY2F0aW9uKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIG5vdGUgdGhlIGJhY2tlbmQgbWlnaHQgcmV0dXJuIGEgbmV3IHN1YnNjcmlwdGlvbiBpZiB0aGUgY2xpZW50IHRvb2sgdG9vIG11Y2ggdGltZSB0byByZWNvbm5lY3QuXG4gICAgICAgICAgICAgICAgICAgICAgICByZWdpc3RlclN1YnNjcmlwdGlvbigpO1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9LCBsaXN0ZW5Ob3cgPyAwIDogMjAwMCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIHJlZ2lzdGVyU3Vic2NyaXB0aW9uKCkge1xuICAgICAgICAgICAgICAgICRzb2NrZXRpby5mZXRjaCgnc3luYy5zdWJzY3JpYmUnLCB7XG4gICAgICAgICAgICAgICAgICAgIHZlcnNpb246IFNZTkNfVkVSU0lPTixcbiAgICAgICAgICAgICAgICAgICAgaWQ6IHN1YnNjcmlwdGlvbklkLCAvLyB0byB0cnkgdG8gcmUtdXNlIGV4aXN0aW5nIHN1YmNyaXB0aW9uXG4gICAgICAgICAgICAgICAgICAgIHB1YmxpY2F0aW9uOiBwdWJsaWNhdGlvbixcbiAgICAgICAgICAgICAgICAgICAgcGFyYW1zOiBzdWJQYXJhbXNcbiAgICAgICAgICAgICAgICB9KS50aGVuKGZ1bmN0aW9uIChzdWJJZCkge1xuICAgICAgICAgICAgICAgICAgICBzdWJzY3JpcHRpb25JZCA9IHN1YklkO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiB1bnJlZ2lzdGVyU3Vic2NyaXB0aW9uKCkge1xuICAgICAgICAgICAgICAgIGlmIChzdWJzY3JpcHRpb25JZCkge1xuICAgICAgICAgICAgICAgICAgICAkc29ja2V0aW8uZmV0Y2goJ3N5bmMudW5zdWJzY3JpYmUnLCB7XG4gICAgICAgICAgICAgICAgICAgICAgICB2ZXJzaW9uOiBTWU5DX1ZFUlNJT04sXG4gICAgICAgICAgICAgICAgICAgICAgICBpZDogc3Vic2NyaXB0aW9uSWRcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgICAgIHN1YnNjcmlwdGlvbklkID0gbnVsbDtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIGxpc3RlblRvUHVibGljYXRpb24oKSB7XG4gICAgICAgICAgICAgICAgLy8gY2Fubm90IG9ubHkgbGlzdGVuIHRvIHN1YnNjcmlwdGlvbklkIHlldC4uLmJlY2F1c2UgdGhlIHJlZ2lzdHJhdGlvbiBtaWdodCBoYXZlIGFuc3dlciBwcm92aWRlZCBpdHMgaWQgeWV0Li4uYnV0IHN0YXJ0ZWQgYnJvYWRjYXN0aW5nIGNoYW5nZXMuLi5AVE9ETyBjYW4gYmUgaW1wcm92ZWQuLi5cbiAgICAgICAgICAgICAgICBwdWJsaWNhdGlvbkxpc3RlbmVyT2ZmID0gYWRkUHVibGljYXRpb25MaXN0ZW5lcihwdWJsaWNhdGlvbiwgZnVuY3Rpb24gKGJhdGNoKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChzdWJzY3JpcHRpb25JZCA9PT0gYmF0Y2guc3Vic2NyaXB0aW9uSWQgfHwgKCFzdWJzY3JpcHRpb25JZCAmJiBjaGVja0RhdGFTZXRQYXJhbXNJZk1hdGNoaW5nQmF0Y2hQYXJhbXMoYmF0Y2gucGFyYW1zKSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghYmF0Y2guZGlmZikge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIC8vIENsZWFyIHRoZSBjYWNoZSB0byByZWJ1aWxkIGl0IGlmIGFsbCBkYXRhIHdhcyByZWNlaXZlZC5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICByZWNvcmRTdGF0ZXMgPSB7fTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWlzU2luZ2xlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhY2hlLmxlbmd0aCA9IDA7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgYXBwbHlDaGFuZ2VzKGJhdGNoLnJlY29yZHMpO1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFpc0luaXRpYWxQdXNoQ29tcGxldGVkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaXNJbml0aWFsUHVzaENvbXBsZXRlZCA9IHRydWU7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgZGVmZXJyZWRJbml0aWFsaXphdGlvbi5yZXNvbHZlKGdldERhdGEoKSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAqIGlmIHRoZSBwYXJhbXMgb2YgdGhlIGRhdGFzZXQgbWF0Y2hlcyB0aGUgbm90aWZpY2F0aW9uLCBpdCBtZWFucyB0aGUgZGF0YSBuZWVkcyB0byBiZSBjb2xsZWN0IHRvIHVwZGF0ZSBhcnJheS5cbiAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBjaGVja0RhdGFTZXRQYXJhbXNJZk1hdGNoaW5nQmF0Y2hQYXJhbXMoYmF0Y2hQYXJhbXMpIHtcbiAgICAgICAgICAgICAgICAvLyBpZiAocGFyYW1zLmxlbmd0aCAhPSBzdHJlYW1QYXJhbXMubGVuZ3RoKSB7XG4gICAgICAgICAgICAgICAgLy8gICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgICAgICAvLyB9XG4gICAgICAgICAgICAgICAgaWYgKCFzdWJQYXJhbXMgfHwgT2JqZWN0LmtleXMoc3ViUGFyYW1zKS5sZW5ndGggPT0gMCkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB2YXIgbWF0Y2hpbmcgPSB0cnVlO1xuICAgICAgICAgICAgICAgIGZvciAodmFyIHBhcmFtIGluIGJhdGNoUGFyYW1zKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIGFyZSBvdGhlciBwYXJhbXMgbWF0Y2hpbmc/XG4gICAgICAgICAgICAgICAgICAgIC8vIGV4OiB3ZSBtaWdodCBoYXZlIHJlY2VpdmUgYSBub3RpZmljYXRpb24gYWJvdXQgdGFza0lkPTIwIGJ1dCB0aGlzIHN1YnNjcmlwdGlvbiBhcmUgb25seSBpbnRlcmVzdGVkIGFib3V0IHRhc2tJZC0zXG4gICAgICAgICAgICAgICAgICAgIGlmIChiYXRjaFBhcmFtc1twYXJhbV0gIT09IHN1YlBhcmFtc1twYXJhbV0pIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIG1hdGNoaW5nID0gZmFsc2U7XG4gICAgICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICByZXR1cm4gbWF0Y2hpbmc7XG5cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy8gZmV0Y2ggYWxsIHRoZSBtaXNzaW5nIHJlY29yZHMsIGFuZCBhY3RpdmF0ZSB0aGUgY2FsbCBiYWNrcyAoYWRkLHVwZGF0ZSxyZW1vdmUpIGFjY29yZGluZ2x5IGlmIHRoZXJlIGlzIHNvbWV0aGluZyB0aGF0IGlzIG5ldyBvciBub3QgYWxyZWFkeSBpbiBzeW5jLlxuICAgICAgICAgICAgZnVuY3Rpb24gYXBwbHlDaGFuZ2VzKHJlY29yZHMpIHtcbiAgICAgICAgICAgICAgICB2YXIgbmV3RGF0YUFycmF5ID0gW107XG4gICAgICAgICAgICAgICAgdmFyIG5ld0RhdGE7XG4gICAgICAgICAgICAgICAgc0RzLnJlYWR5ID0gZmFsc2U7XG4gICAgICAgICAgICAgICAgcmVjb3Jkcy5mb3JFYWNoKGZ1bmN0aW9uIChyZWNvcmQpIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gICAgICAgICAgICAgICAgICAgbG9nSW5mbygnRGF0YXN5bmMgWycgKyBkYXRhU3RyZWFtTmFtZSArICddIHJlY2VpdmVkOicgK0pTT04uc3RyaW5naWZ5KHJlY29yZCkpOy8vKyByZWNvcmQuaWQpO1xuICAgICAgICAgICAgICAgICAgICBpZiAocmVjb3JkLnJlbW92ZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgcmVtb3ZlUmVjb3JkKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAocmVjb3JkU3RhdGVzW3JlY29yZC5pZF0pIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIGlmIHRoZSByZWNvcmQgaXMgYWxyZWFkeSBwcmVzZW50IGluIHRoZSBjYWNoZS4uLnNvIGl0IGlzIG1pZ2h0YmUgYW4gdXBkYXRlLi5cbiAgICAgICAgICAgICAgICAgICAgICAgIG5ld0RhdGEgPSB1cGRhdGVSZWNvcmQocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIG5ld0RhdGEgPSBhZGRSZWNvcmQocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBpZiAobmV3RGF0YSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgbmV3RGF0YUFycmF5LnB1c2gobmV3RGF0YSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICBzRHMucmVhZHkgPSB0cnVlO1xuICAgICAgICAgICAgICAgIGlmIChpc1NpbmdsZSkge1xuICAgICAgICAgICAgICAgICAgICBzeW5jTGlzdGVuZXIubm90aWZ5KCdyZWFkeScsIGdldERhdGEoKSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgc3luY0xpc3RlbmVyLm5vdGlmeSgncmVhZHknLCBnZXREYXRhKCksIG5ld0RhdGFBcnJheSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqIEFsdGhvdWdoIG1vc3QgY2FzZXMgYXJlIGhhbmRsZWQgdXNpbmcgb25SZWFkeSwgdGhpcyB0ZWxscyB5b3UgdGhlIGN1cnJlbnQgZGF0YSBzdGF0ZS5cbiAgICAgICAgICAgICAqIFxuICAgICAgICAgICAgICogQHJldHVybnMgaWYgdHJ1ZSBpcyBhIHN5bmMgaGFzIGJlZW4gcHJvY2Vzc2VkIG90aGVyd2lzZSBmYWxzZSBpZiB0aGUgZGF0YSBpcyBub3QgcmVhZHkuXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIGlzUmVhZHkoKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRoaXMucmVhZHk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqIFxuICAgICAgICAgICAgICogcmV0dXJucyBhIGZ1bmN0aW9uIHRvIHJlbW92ZSB0aGUgbGlzdGVuZXIuXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIG9uQWRkKGNhbGxiYWNrKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHN5bmNMaXN0ZW5lci5vbignYWRkJywgY2FsbGJhY2spO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqIFxuICAgICAgICAgICAgICogcmV0dXJucyBhIGZ1bmN0aW9uIHRvIHJlbW92ZSB0aGUgbGlzdGVuZXIuXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIG9uVXBkYXRlKGNhbGxiYWNrKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHN5bmNMaXN0ZW5lci5vbigndXBkYXRlJywgY2FsbGJhY2spO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqIFxuICAgICAgICAgICAgICogcmV0dXJucyBhIGZ1bmN0aW9uIHRvIHJlbW92ZSB0aGUgbGlzdGVuZXIuXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIG9uUmVtb3ZlKGNhbGxiYWNrKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHN5bmNMaXN0ZW5lci5vbigncmVtb3ZlJywgY2FsbGJhY2spO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqIFxuICAgICAgICAgICAgICogcmV0dXJucyBhIGZ1bmN0aW9uIHRvIHJlbW92ZSB0aGUgbGlzdGVuZXIuXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIG9uUmVhZHkoY2FsbGJhY2spIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gc3luY0xpc3RlbmVyLm9uKCdyZWFkeScsIGNhbGxiYWNrKTtcbiAgICAgICAgICAgIH1cblxuXG4gICAgICAgICAgICBmdW5jdGlvbiBhZGRSZWNvcmQocmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgbG9nRGVidWcoJ1N5bmMgLT4gSW5zZXJ0ZWQgTmV3IHJlY29yZCAjJyArIHJlY29yZC5pZCArICcgZm9yIHN1YnNjcmlwdGlvbiB0byAnICsgcHVibGljYXRpb24pOy8vIEpTT04uc3RyaW5naWZ5KHJlY29yZCkpO1xuICAgICAgICAgICAgICAgIGdldFJldmlzaW9uKHJlY29yZCk7IC8vIGp1c3QgbWFrZSBzdXJlIHdlIGNhbiBnZXQgYSByZXZpc2lvbiBiZWZvcmUgd2UgaGFuZGxlIHRoaXMgcmVjb3JkXG4gICAgICAgICAgICAgICAgdXBkYXRlRGF0YVN0b3JhZ2UoZm9ybWF0UmVjb3JkID8gZm9ybWF0UmVjb3JkKHJlY29yZCkgOiByZWNvcmQpO1xuICAgICAgICAgICAgICAgIHN5bmNMaXN0ZW5lci5ub3RpZnkoJ2FkZCcsIHJlY29yZCk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlY29yZDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gdXBkYXRlUmVjb3JkKHJlY29yZCkge1xuICAgICAgICAgICAgICAgIHZhciBwcmV2aW91cyA9IHJlY29yZFN0YXRlc1tyZWNvcmQuaWRdO1xuICAgICAgICAgICAgICAgIGlmIChnZXRSZXZpc2lvbihyZWNvcmQpIDw9IGdldFJldmlzaW9uKHByZXZpb3VzKSkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgbG9nRGVidWcoJ1N5bmMgLT4gVXBkYXRlZCByZWNvcmQgIycgKyByZWNvcmQuaWQgKyAnIGZvciBzdWJzY3JpcHRpb24gdG8gJyArIHB1YmxpY2F0aW9uKTsvLyBKU09OLnN0cmluZ2lmeShyZWNvcmQpKTtcbiAgICAgICAgICAgICAgICB1cGRhdGVEYXRhU3RvcmFnZShmb3JtYXRSZWNvcmQgPyBmb3JtYXRSZWNvcmQocmVjb3JkKSA6IHJlY29yZCk7XG4gICAgICAgICAgICAgICAgc3luY0xpc3RlbmVyLm5vdGlmeSgndXBkYXRlJywgcmVjb3JkKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gcmVjb3JkO1xuICAgICAgICAgICAgfVxuXG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIHJlbW92ZVJlY29yZChyZWNvcmQpIHtcbiAgICAgICAgICAgICAgICB2YXIgcHJldmlvdXMgPSByZWNvcmRTdGF0ZXNbcmVjb3JkLmlkXTtcbiAgICAgICAgICAgICAgICBpZiAoIXByZXZpb3VzIHx8IGdldFJldmlzaW9uKHJlY29yZCkgPiBnZXRSZXZpc2lvbihwcmV2aW91cykpIHtcbiAgICAgICAgICAgICAgICAgICAgbG9nRGVidWcoJ1N5bmMgLT4gUmVtb3ZlZCAjJyArIHJlY29yZC5pZCArICcgZm9yIHN1YnNjcmlwdGlvbiB0byAnICsgcHVibGljYXRpb24pO1xuICAgICAgICAgICAgICAgICAgICAvLyBXZSBjb3VsZCBoYXZlIGZvciB0aGUgc2FtZSByZWNvcmQgY29uc2VjdXRpdmVseSBmZXRjaGluZyBpbiB0aGlzIG9yZGVyOlxuICAgICAgICAgICAgICAgICAgICAvLyBkZWxldGUgaWQ6NCwgcmV2IDEwLCB0aGVuIGFkZCBpZDo0LCByZXYgOS4uLi4gYnkga2VlcGluZyB0cmFjayBvZiB3aGF0IHdhcyBkZWxldGVkLCB3ZSB3aWxsIG5vdCBhZGQgdGhlIHJlY29yZCBzaW5jZSBpdCB3YXMgZGVsZXRlZCB3aXRoIGEgbW9zdCByZWNlbnQgdGltZXN0YW1wLlxuICAgICAgICAgICAgICAgICAgICByZWNvcmQucmVtb3ZlZCA9IHRydWU7IC8vIFNvIHdlIG9ubHkgZmxhZyBhcyByZW1vdmVkLCBsYXRlciBvbiB0aGUgZ2FyYmFnZSBjb2xsZWN0b3Igd2lsbCBnZXQgcmlkIG9mIGl0LiAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICB1cGRhdGVEYXRhU3RvcmFnZShyZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICAvLyBpZiB0aGVyZSBpcyBubyBwcmV2aW91cyByZWNvcmQgd2UgZG8gbm90IG5lZWQgdG8gcmVtb3ZlZCBhbnkgdGhpbmcgZnJvbSBvdXIgc3RvcmFnZS4gICAgIFxuICAgICAgICAgICAgICAgICAgICBpZiAocHJldmlvdXMpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHN5bmNMaXN0ZW5lci5ub3RpZnkoJ3JlbW92ZScsIHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgICAgICBkaXNwb3NlKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBmdW5jdGlvbiBkaXNwb3NlKHJlY29yZCkge1xuICAgICAgICAgICAgICAgICRzeW5jR2FyYmFnZUNvbGxlY3Rvci5kaXNwb3NlKGZ1bmN0aW9uIGNvbGxlY3QoKSB7XG4gICAgICAgICAgICAgICAgICAgIHZhciBleGlzdGluZ1JlY29yZCA9IHJlY29yZFN0YXRlc1tyZWNvcmQuaWRdO1xuICAgICAgICAgICAgICAgICAgICBpZiAoZXhpc3RpbmdSZWNvcmQgJiYgcmVjb3JkLnJldmlzaW9uID49IGV4aXN0aW5nUmVjb3JkLnJldmlzaW9uXG4gICAgICAgICAgICAgICAgICAgICkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy9sb2dEZWJ1ZygnQ29sbGVjdCBOb3c6JyArIEpTT04uc3RyaW5naWZ5KHJlY29yZCkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgZGVsZXRlIHJlY29yZFN0YXRlc1tyZWNvcmQuaWRdO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIGlzRXhpc3RpbmdTdGF0ZUZvcihyZWNvcmRJZCkge1xuICAgICAgICAgICAgICAgIHJldHVybiAhIXJlY29yZFN0YXRlc1tyZWNvcmRJZF07XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIHVwZGF0ZVN5bmNlZE9iamVjdChyZWNvcmQpIHtcbiAgICAgICAgICAgICAgICByZWNvcmRTdGF0ZXNbcmVjb3JkLmlkXSA9IHJlY29yZDtcblxuICAgICAgICAgICAgICAgIGlmICghcmVjb3JkLnJlbW92ZSkge1xuICAgICAgICAgICAgICAgICAgICAkc3luY01lcmdlLm1lcmdlKGNhY2hlLCByZWNvcmQsIHN0cmljdE1vZGUpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICRzeW5jTWVyZ2UuY2xlYXJPYmplY3QoY2FjaGUpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gdXBkYXRlU3luY2VkQXJyYXkocmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgdmFyIGV4aXN0aW5nID0gcmVjb3JkU3RhdGVzW3JlY29yZC5pZF07XG4gICAgICAgICAgICAgICAgaWYgKCFleGlzdGluZykge1xuICAgICAgICAgICAgICAgICAgICAvLyBhZGQgbmV3IGluc3RhbmNlXG4gICAgICAgICAgICAgICAgICAgIHJlY29yZFN0YXRlc1tyZWNvcmQuaWRdID0gcmVjb3JkO1xuICAgICAgICAgICAgICAgICAgICBpZiAoIXJlY29yZC5yZW1vdmVkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjYWNoZS5wdXNoKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAkc3luY01lcmdlLm1lcmdlKGV4aXN0aW5nLCByZWNvcmQsIHN0cmljdE1vZGUpO1xuICAgICAgICAgICAgICAgICAgICBpZiAocmVjb3JkLnJlbW92ZWQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGNhY2hlLnNwbGljZShjYWNoZS5pbmRleE9mKGV4aXN0aW5nKSwgMSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cblxuXG5cblxuICAgICAgICAgICAgZnVuY3Rpb24gZ2V0UmV2aXNpb24ocmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgLy8gd2hhdCByZXNlcnZlZCBmaWVsZCBkbyB3ZSB1c2UgYXMgdGltZXN0YW1wXG4gICAgICAgICAgICAgICAgaWYgKGFuZ3VsYXIuaXNEZWZpbmVkKHJlY29yZC5yZXZpc2lvbikpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHJlY29yZC5yZXZpc2lvbjtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgaWYgKGFuZ3VsYXIuaXNEZWZpbmVkKHJlY29yZC50aW1lc3RhbXApKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiByZWNvcmQudGltZXN0YW1wO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1N5bmMgcmVxdWlyZXMgYSByZXZpc2lvbiBvciB0aW1lc3RhbXAgcHJvcGVydHkgaW4gcmVjZWl2ZWQgJyArIChvYmplY3RDbGFzcyA/ICdvYmplY3QgWycgKyBvYmplY3RDbGFzcy5uYW1lICsgJ10nIDogJ3JlY29yZCcpKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiB0aGlzIG9iamVjdCBcbiAgICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIFN5bmNMaXN0ZW5lcigpIHtcbiAgICAgICAgICAgIHZhciBldmVudHMgPSB7fTtcbiAgICAgICAgICAgIHZhciBjb3VudCA9IDA7XG5cbiAgICAgICAgICAgIHRoaXMubm90aWZ5ID0gbm90aWZ5O1xuICAgICAgICAgICAgdGhpcy5vbiA9IG9uO1xuXG4gICAgICAgICAgICBmdW5jdGlvbiBub3RpZnkoZXZlbnQsIGRhdGExLCBkYXRhMikge1xuICAgICAgICAgICAgICAgIHZhciBsaXN0ZW5lcnMgPSBldmVudHNbZXZlbnRdO1xuICAgICAgICAgICAgICAgIGlmIChsaXN0ZW5lcnMpIHtcbiAgICAgICAgICAgICAgICAgICAgXy5mb3JFYWNoKGxpc3RlbmVycywgZnVuY3Rpb24gKGNhbGxiYWNrLCBpZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgY2FsbGJhY2soZGF0YTEsIGRhdGEyKTtcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqIEByZXR1cm5zIGhhbmRsZXIgdG8gdW5yZWdpc3RlciBsaXN0ZW5lclxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBvbihldmVudCwgY2FsbGJhY2spIHtcbiAgICAgICAgICAgICAgICB2YXIgbGlzdGVuZXJzID0gZXZlbnRzW2V2ZW50XTtcbiAgICAgICAgICAgICAgICBpZiAoIWxpc3RlbmVycykge1xuICAgICAgICAgICAgICAgICAgICBsaXN0ZW5lcnMgPSBldmVudHNbZXZlbnRdID0ge307XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHZhciBpZCA9IGNvdW50Kys7XG4gICAgICAgICAgICAgICAgbGlzdGVuZXJzW2lkKytdID0gY2FsbGJhY2s7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICAgICAgZGVsZXRlIGxpc3RlbmVyc1tpZF07XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfTtcblxuICAgIGZ1bmN0aW9uIGxvZ0luZm8obXNnKSB7XG4gICAgICAgIGlmIChkZWJ1Zykge1xuICAgICAgICAgICAgY29uc29sZS5kZWJ1ZygnU1lOQyhpbmZvKTogJyArIG1zZyk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBmdW5jdGlvbiBsb2dEZWJ1Zyhtc2cpIHtcbiAgICAgICAgaWYgKGRlYnVnID09IDIpIHtcbiAgICAgICAgICAgIGNvbnNvbGUuZGVidWcoJ1NZTkMoZGVidWcpOiAnICsgbXNnKTtcbiAgICAgICAgfVxuXG4gICAgfVxuXG5cblxufTtcbn0oKSk7XG4iXX0=
