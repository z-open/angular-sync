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
        update: update,
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

    function update(destination, source, isStrictMode) {

        var processed = [];

        return updateObject(destination, source, isStrictMode);

        function findProcessed(value) {
            if (!_.isArray(value) && !_.isObject(value) && !_.isDate(value) && !_.isFunction(value)) {
                return null;
            }
            var found = _.find(processed, function (p) {
                return value === p.value;
            });
            return found ? found.newValue : null;
        }

        function updateObject(destination, source, isStrictMode) {
            if (!destination) {
                return source;// _.assign({}, source);;
            }
            // create new object containing only the properties of source merge with destination
            var object = {};
            for (var property in source) {
                var processedData = findProcessed(source[property]);

//Object.getOwnPropertyDescriptor                
                var d = Object.getOwnPropertyDescriptor(source, property);
                if (processedData) {
                    object[property] = processedData;
                } else 
                    if (d && (d.set || d.get)) {
                        // do nothing, it is computed
                        
                    } else

                    if (_.isArray(source[property])) {
                        object[property] = updateArray(destination[property], source[property], isStrictMode);

                        processed.push({ value: source[property], newValue: object[property] });

                    } else if (_.isFunction(source[property])) {
                        object[property] = source[property];

                        processed.push({ value: source[property], newValue: object[property] });

                        // should do nothing...no function be added!

                    } else if (_.isObject(source[property]) && !_.isDate(source[property])) {
                        object[property] = updateObject(destination[property], source[property], isStrictMode);

                        processed.push({ value: source[property], newValue: object[property] });

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

                var processedData = findProcessed(item);
                if (processedData) {
                    array.push(processedData);
                } else

                    // does not try to maintain object references in arrays
                    // super loose mode.
                    if (isStrictMode === 'NONE') {
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

    this.$get = function sync($rootScope, $q, $socketio, $syncGarbageCollector, $syncMerge) {

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
    };
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

//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInN5bmMubW9kdWxlLmpzIiwic2VydmljZXMvc3luYy1nYXJiYWdlLWNvbGxlY3Rvci5zZXJ2aWNlLmpzIiwic2VydmljZXMvc3luYy1tZXJnZS5zZXJ2aWNlLmpzIiwic2VydmljZXMvc3luYy5zZXJ2aWNlLmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7OztBQUFBO0FBQ0E7Ozs7OztBQ0RBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7Ozs7O0FDekVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7Ozs7O0FDdElBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0EiLCJmaWxlIjoiYXBwLWlpZmUuanMiLCJzb3VyY2VzQ29udGVudCI6WyJhbmd1bGFyXG4gICAgLm1vZHVsZSgnc3luYycsIFsnc29ja2V0aW8tYXV0aCddKTtcbiIsImFuZ3VsYXJcbiAgICAubW9kdWxlKCdzeW5jJylcbiAgICAuZmFjdG9yeSgnJHN5bmNHYXJiYWdlQ29sbGVjdG9yJywgc3luY0dhcmJhZ2VDb2xsZWN0b3IpO1xuXG4vKipcbiAqIHNhZmVseSByZW1vdmUgZGVsZXRlZCByZWNvcmQvb2JqZWN0IGZyb20gbWVtb3J5IGFmdGVyIHRoZSBzeW5jIHByb2Nlc3MgZGlzcG9zZWQgdGhlbS5cbiAqIFxuICogVE9ETzogU2Vjb25kcyBzaG91bGQgcmVmbGVjdCB0aGUgbWF4IHRpbWUgIHRoYXQgc3luYyBjYWNoZSBpcyB2YWxpZCAobmV0d29yayBsb3NzIHdvdWxkIGZvcmNlIGEgcmVzeW5jKSwgd2hpY2ggc2hvdWxkIG1hdGNoIG1heERpc2Nvbm5lY3Rpb25UaW1lQmVmb3JlRHJvcHBpbmdTdWJzY3JpcHRpb24gb24gdGhlIHNlcnZlciBzaWRlLlxuICogXG4gKiBOb3RlOlxuICogcmVtb3ZlZCByZWNvcmQgc2hvdWxkIGJlIGRlbGV0ZWQgZnJvbSB0aGUgc3luYyBpbnRlcm5hbCBjYWNoZSBhZnRlciBhIHdoaWxlIHNvIHRoYXQgdGhleSBkbyBub3Qgc3RheSBpbiB0aGUgbWVtb3J5LiBUaGV5IGNhbm5vdCBiZSByZW1vdmVkIHRvbyBlYXJseSBhcyBhbiBvbGRlciB2ZXJzaW9uL3N0YW1wIG9mIHRoZSByZWNvcmQgY291bGQgYmUgcmVjZWl2ZWQgYWZ0ZXIgaXRzIHJlbW92YWwuLi53aGljaCB3b3VsZCByZS1hZGQgdG8gY2FjaGUuLi5kdWUgYXN5bmNocm9ub3VzIHByb2Nlc3NpbmcuLi5cbiAqL1xuZnVuY3Rpb24gc3luY0dhcmJhZ2VDb2xsZWN0b3IoKSB7XG4gICAgdmFyIGl0ZW1zID0gW107XG4gICAgdmFyIHNlY29uZHMgPSAyO1xuICAgIHZhciBzY2hlZHVsZWQgPSBmYWxzZTtcblxuICAgIHZhciBzZXJ2aWNlID0ge1xuICAgICAgICBzZXRTZWNvbmRzOiBzZXRTZWNvbmRzLFxuICAgICAgICBnZXRTZWNvbmRzOiBnZXRTZWNvbmRzLFxuICAgICAgICBkaXNwb3NlOiBkaXNwb3NlLFxuICAgICAgICBzY2hlZHVsZTogc2NoZWR1bGUsXG4gICAgICAgIHJ1bjogcnVuLFxuICAgICAgICBnZXRJdGVtQ291bnQ6IGdldEl0ZW1Db3VudFxuICAgIH07XG5cbiAgICByZXR1cm4gc2VydmljZTtcblxuICAgIC8vLy8vLy8vLy9cblxuICAgIGZ1bmN0aW9uIHNldFNlY29uZHModmFsdWUpIHtcbiAgICAgICAgc2Vjb25kcyA9IHZhbHVlO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIGdldFNlY29uZHMoKSB7XG4gICAgICAgIHJldHVybiBzZWNvbmRzO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIGdldEl0ZW1Db3VudCgpIHtcbiAgICAgICAgcmV0dXJuIGl0ZW1zLmxlbmd0aDtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBkaXNwb3NlKGNvbGxlY3QpIHtcbiAgICAgICAgaXRlbXMucHVzaCh7XG4gICAgICAgICAgICB0aW1lc3RhbXA6IERhdGUubm93KCksXG4gICAgICAgICAgICBjb2xsZWN0OiBjb2xsZWN0XG4gICAgICAgIH0pO1xuICAgICAgICBpZiAoIXNjaGVkdWxlZCkge1xuICAgICAgICAgICAgc2VydmljZS5zY2hlZHVsZSgpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gc2NoZWR1bGUoKSB7XG4gICAgICAgIGlmICghc2Vjb25kcykge1xuICAgICAgICAgICAgc2VydmljZS5ydW4oKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBzY2hlZHVsZWQgPSB0cnVlO1xuICAgICAgICBzZXRUaW1lb3V0KGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIHNlcnZpY2UucnVuKCk7XG4gICAgICAgICAgICBpZiAoaXRlbXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICAgIHNjaGVkdWxlKCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHNjaGVkdWxlZCA9IGZhbHNlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9LCBzZWNvbmRzICogMTAwMCk7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gcnVuKCkge1xuICAgICAgICB2YXIgdGltZW91dCA9IERhdGUubm93KCkgLSBzZWNvbmRzICogMTAwMDtcbiAgICAgICAgd2hpbGUgKGl0ZW1zLmxlbmd0aCA+IDAgJiYgaXRlbXNbMF0udGltZXN0YW1wIDw9IHRpbWVvdXQpIHtcbiAgICAgICAgICAgIGl0ZW1zLnNoaWZ0KCkuY29sbGVjdCgpO1xuICAgICAgICB9XG4gICAgfVxufVxuXG5cbiIsIlxuYW5ndWxhclxuICAgIC5tb2R1bGUoJ3N5bmMnKVxuICAgIC5mYWN0b3J5KCckc3luY01lcmdlJywgc3luY01lcmdlKTtcblxuZnVuY3Rpb24gc3luY01lcmdlKCkge1xuXG4gICAgcmV0dXJuIHtcbiAgICAgICAgdXBkYXRlOiB1cGRhdGUsXG4gICAgICAgIGNsZWFyT2JqZWN0OiBjbGVhck9iamVjdFxuICAgIH1cblxuXG4gICAgLyoqXG4gICAgICogVGhpcyBmdW5jdGlvbiB1cGRhdGVzIGFuIG9iamVjdCB3aXRoIHRoZSBjb250ZW50IG9mIGFub3RoZXIuXG4gICAgICogVGhlIGlubmVyIG9iamVjdHMgYW5kIG9iamVjdHMgaW4gYXJyYXkgd2lsbCBhbHNvIGJlIHVwZGF0ZWQuXG4gICAgICogUmVmZXJlbmNlcyB0byB0aGUgb3JpZ2luYWwgb2JqZWN0cyBhcmUgbWFpbnRhaW5lZCBpbiB0aGUgZGVzdGluYXRpb24gb2JqZWN0IHNvIE9ubHkgY29udGVudCBpcyB1cGRhdGVkLlxuICAgICAqXG4gICAgICogVGhlIHByb3BlcnRpZXMgaW4gdGhlIHNvdXJjZSBvYmplY3QgdGhhdCBhcmUgbm90IGluIHRoZSBkZXN0aW5hdGlvbiB3aWxsIGJlIHJlbW92ZWQgZnJvbSB0aGUgZGVzdGluYXRpb24gb2JqZWN0LlxuICAgICAqXG4gICAgICogXG4gICAgICpcbiAgICAgKkBwYXJhbSA8b2JqZWN0PiBkZXN0aW5hdGlvbiAgb2JqZWN0IHRvIHVwZGF0ZVxuICAgICAqQHBhcmFtIDxvYmplY3Q+IHNvdXJjZSAgb2JqZWN0IHRvIHVwZGF0ZSBmcm9tXG4gICAgICpAcGFyYW0gPGJvb2xlYW4+IGlzU3RyaWN0TW9kZSBkZWZhdWx0IGZhbHNlLCBpZiB0cnVlIHdvdWxkIGdlbmVyYXRlIGFuIGVycm9yIGlmIGlubmVyIG9iamVjdHMgaW4gYXJyYXkgZG8gbm90IGhhdmUgaWQgZmllbGRcbiAgICAgKi9cblxuICAgIGZ1bmN0aW9uIHVwZGF0ZShkZXN0aW5hdGlvbiwgc291cmNlLCBpc1N0cmljdE1vZGUpIHtcblxuICAgICAgICB2YXIgcHJvY2Vzc2VkID0gW107XG5cbiAgICAgICAgcmV0dXJuIHVwZGF0ZU9iamVjdChkZXN0aW5hdGlvbiwgc291cmNlLCBpc1N0cmljdE1vZGUpO1xuXG4gICAgICAgIGZ1bmN0aW9uIGZpbmRQcm9jZXNzZWQodmFsdWUpIHtcbiAgICAgICAgICAgIGlmICghXy5pc0FycmF5KHZhbHVlKSAmJiAhXy5pc09iamVjdCh2YWx1ZSkgJiYgIV8uaXNEYXRlKHZhbHVlKSAmJiAhXy5pc0Z1bmN0aW9uKHZhbHVlKSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBudWxsO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdmFyIGZvdW5kID0gXy5maW5kKHByb2Nlc3NlZCwgZnVuY3Rpb24gKHApIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdmFsdWUgPT09IHAudmFsdWU7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIHJldHVybiBmb3VuZCA/IGZvdW5kLm5ld1ZhbHVlIDogbnVsbDtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIHVwZGF0ZU9iamVjdChkZXN0aW5hdGlvbiwgc291cmNlLCBpc1N0cmljdE1vZGUpIHtcbiAgICAgICAgICAgIGlmICghZGVzdGluYXRpb24pIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gc291cmNlOy8vIF8uYXNzaWduKHt9LCBzb3VyY2UpOztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIC8vIGNyZWF0ZSBuZXcgb2JqZWN0IGNvbnRhaW5pbmcgb25seSB0aGUgcHJvcGVydGllcyBvZiBzb3VyY2UgbWVyZ2Ugd2l0aCBkZXN0aW5hdGlvblxuICAgICAgICAgICAgdmFyIG9iamVjdCA9IHt9O1xuICAgICAgICAgICAgZm9yICh2YXIgcHJvcGVydHkgaW4gc291cmNlKSB7XG4gICAgICAgICAgICAgICAgdmFyIHByb2Nlc3NlZERhdGEgPSBmaW5kUHJvY2Vzc2VkKHNvdXJjZVtwcm9wZXJ0eV0pO1xuXG4vL09iamVjdC5nZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3IgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgdmFyIGQgPSBPYmplY3QuZ2V0T3duUHJvcGVydHlEZXNjcmlwdG9yKHNvdXJjZSwgcHJvcGVydHkpO1xuICAgICAgICAgICAgICAgIGlmIChwcm9jZXNzZWREYXRhKSB7XG4gICAgICAgICAgICAgICAgICAgIG9iamVjdFtwcm9wZXJ0eV0gPSBwcm9jZXNzZWREYXRhO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBcbiAgICAgICAgICAgICAgICAgICAgaWYgKGQgJiYgKGQuc2V0IHx8IGQuZ2V0KSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy8gZG8gbm90aGluZywgaXQgaXMgY29tcHV0ZWRcbiAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICB9IGVsc2VcblxuICAgICAgICAgICAgICAgICAgICBpZiAoXy5pc0FycmF5KHNvdXJjZVtwcm9wZXJ0eV0pKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBvYmplY3RbcHJvcGVydHldID0gdXBkYXRlQXJyYXkoZGVzdGluYXRpb25bcHJvcGVydHldLCBzb3VyY2VbcHJvcGVydHldLCBpc1N0cmljdE1vZGUpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBwcm9jZXNzZWQucHVzaCh7IHZhbHVlOiBzb3VyY2VbcHJvcGVydHldLCBuZXdWYWx1ZTogb2JqZWN0W3Byb3BlcnR5XSB9KTtcblxuICAgICAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKF8uaXNGdW5jdGlvbihzb3VyY2VbcHJvcGVydHldKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgb2JqZWN0W3Byb3BlcnR5XSA9IHNvdXJjZVtwcm9wZXJ0eV07XG5cbiAgICAgICAgICAgICAgICAgICAgICAgIHByb2Nlc3NlZC5wdXNoKHsgdmFsdWU6IHNvdXJjZVtwcm9wZXJ0eV0sIG5ld1ZhbHVlOiBvYmplY3RbcHJvcGVydHldIH0pO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBzaG91bGQgZG8gbm90aGluZy4uLm5vIGZ1bmN0aW9uIGJlIGFkZGVkIVxuXG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoXy5pc09iamVjdChzb3VyY2VbcHJvcGVydHldKSAmJiAhXy5pc0RhdGUoc291cmNlW3Byb3BlcnR5XSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIG9iamVjdFtwcm9wZXJ0eV0gPSB1cGRhdGVPYmplY3QoZGVzdGluYXRpb25bcHJvcGVydHldLCBzb3VyY2VbcHJvcGVydHldLCBpc1N0cmljdE1vZGUpO1xuXG4gICAgICAgICAgICAgICAgICAgICAgICBwcm9jZXNzZWQucHVzaCh7IHZhbHVlOiBzb3VyY2VbcHJvcGVydHldLCBuZXdWYWx1ZTogb2JqZWN0W3Byb3BlcnR5XSB9KTtcblxuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgb2JqZWN0W3Byb3BlcnR5XSA9IHNvdXJjZVtwcm9wZXJ0eV07XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY2xlYXJPYmplY3QoZGVzdGluYXRpb24pO1xuICAgICAgICAgICAgXy5hc3NpZ24oZGVzdGluYXRpb24sIG9iamVjdCk7XG5cbiAgICAgICAgICAgIHJldHVybiBkZXN0aW5hdGlvbjtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIHVwZGF0ZUFycmF5KGRlc3RpbmF0aW9uLCBzb3VyY2UsIGlzU3RyaWN0TW9kZSkge1xuICAgICAgICAgICAgaWYgKCFkZXN0aW5hdGlvbikge1xuICAgICAgICAgICAgICAgIHJldHVybiBzb3VyY2U7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICB2YXIgYXJyYXkgPSBbXTtcbiAgICAgICAgICAgIHNvdXJjZS5mb3JFYWNoKGZ1bmN0aW9uIChpdGVtKSB7XG5cbiAgICAgICAgICAgICAgICB2YXIgcHJvY2Vzc2VkRGF0YSA9IGZpbmRQcm9jZXNzZWQoaXRlbSk7XG4gICAgICAgICAgICAgICAgaWYgKHByb2Nlc3NlZERhdGEpIHtcbiAgICAgICAgICAgICAgICAgICAgYXJyYXkucHVzaChwcm9jZXNzZWREYXRhKTtcbiAgICAgICAgICAgICAgICB9IGVsc2VcblxuICAgICAgICAgICAgICAgICAgICAvLyBkb2VzIG5vdCB0cnkgdG8gbWFpbnRhaW4gb2JqZWN0IHJlZmVyZW5jZXMgaW4gYXJyYXlzXG4gICAgICAgICAgICAgICAgICAgIC8vIHN1cGVyIGxvb3NlIG1vZGUuXG4gICAgICAgICAgICAgICAgICAgIGlmIChpc1N0cmljdE1vZGUgPT09ICdOT05FJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgYXJyYXkucHVzaChpdGVtKTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIG9iamVjdCBpbiBhcnJheSBtdXN0IGhhdmUgYW4gaWQgb3RoZXJ3aXNlIHdlIGNhbid0IG1haW50YWluIHRoZSBpbnN0YW5jZSByZWZlcmVuY2VcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghXy5pc0FycmF5KGl0ZW0pICYmIF8uaXNPYmplY3QoaXRlbSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAvLyBsZXQgdHJ5IHRvIGZpbmQgdGhlIGluc3RhbmNlXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGFuZ3VsYXIuaXNEZWZpbmVkKGl0ZW0uaWQpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFycmF5LnB1c2godXBkYXRlT2JqZWN0KF8uZmluZChkZXN0aW5hdGlvbiwgZnVuY3Rpb24gKG9iaikge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgcmV0dXJuIG9iai5pZC50b1N0cmluZygpID09PSBpdGVtLmlkLnRvU3RyaW5nKCk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH0pLCBpdGVtLCBpc1N0cmljdE1vZGUpKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaXNTdHJpY3RNb2RlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ29iamVjdHMgaW4gYXJyYXkgbXVzdCBoYXZlIGFuIGlkIG90aGVyd2lzZSB3ZSBjYW5cXCd0IG1haW50YWluIHRoZSBpbnN0YW5jZSByZWZlcmVuY2UuICcgKyBKU09OLnN0cmluZ2lmeShpdGVtKSk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgYXJyYXkucHVzaChpdGVtKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFycmF5LnB1c2goaXRlbSk7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuXG4gICAgICAgICAgICBkZXN0aW5hdGlvbi5sZW5ndGggPSAwO1xuICAgICAgICAgICAgQXJyYXkucHJvdG90eXBlLnB1c2guYXBwbHkoZGVzdGluYXRpb24sIGFycmF5KTtcbiAgICAgICAgICAgIC8vYW5ndWxhci5jb3B5KGRlc3RpbmF0aW9uLCBhcnJheSk7XG4gICAgICAgICAgICByZXR1cm4gZGVzdGluYXRpb247XG4gICAgICAgIH1cbiAgICB9XG4gICAgZnVuY3Rpb24gY2xlYXJPYmplY3Qob2JqZWN0KSB7XG4gICAgICAgIE9iamVjdC5rZXlzKG9iamVjdCkuZm9yRWFjaChmdW5jdGlvbiAoa2V5KSB7IGRlbGV0ZSBvYmplY3Rba2V5XTsgfSk7XG4gICAgfVxufTtcblxuIiwiXG4vKipcbiAqIFxuICogU2VydmljZSB0aGF0IGFsbG93cyBhbiBhcnJheSBvZiBkYXRhIHJlbWFpbiBpbiBzeW5jIHdpdGggYmFja2VuZC5cbiAqIFxuICogXG4gKiBleDpcbiAqIHdoZW4gdGhlcmUgaXMgYSBub3RpZmljYXRpb24sIG5vdGljYXRpb25TZXJ2aWNlIG5vdGlmaWVzIHRoYXQgdGhlcmUgaXMgc29tZXRoaW5nIG5ldy4uLnRoZW4gdGhlIGRhdGFzZXQgZ2V0IHRoZSBkYXRhIGFuZCBub3RpZmllcyBhbGwgaXRzIGNhbGxiYWNrLlxuICogXG4gKiBOT1RFOiBcbiAqICBcbiAqIFxuICogUHJlLVJlcXVpc3RlOlxuICogLS0tLS0tLS0tLS0tLVxuICogU3luYyByZXF1aXJlcyBvYmplY3RzIGhhdmUgQk9USCBpZCBhbmQgcmV2aXNpb24gZmllbGRzL3Byb3BlcnRpZXMuXG4gKiBcbiAqIFdoZW4gdGhlIGJhY2tlbmQgd3JpdGVzIGFueSBkYXRhIHRvIHRoZSBkYiB0aGF0IGFyZSBzdXBwb3NlZCB0byBiZSBzeW5jcm9uaXplZDpcbiAqIEl0IG11c3QgbWFrZSBzdXJlIGVhY2ggYWRkLCB1cGRhdGUsIHJlbW92YWwgb2YgcmVjb3JkIGlzIHRpbWVzdGFtcGVkLlxuICogSXQgbXVzdCBub3RpZnkgdGhlIGRhdGFzdHJlYW0gKHdpdGggbm90aWZ5Q2hhbmdlIG9yIG5vdGlmeVJlbW92YWwpIHdpdGggc29tZSBwYXJhbXMgc28gdGhhdCBiYWNrZW5kIGtub3dzIHRoYXQgaXQgaGFzIHRvIHB1c2ggYmFjayB0aGUgZGF0YSBiYWNrIHRvIHRoZSBzdWJzY3JpYmVycyAoZXg6IHRoZSB0YXNrQ3JlYXRpb24gd291bGQgbm90aWZ5IHdpdGggaXRzIHBsYW5JZClcbiogXG4gKiBcbiAqL1xuYW5ndWxhclxuICAgIC5tb2R1bGUoJ3N5bmMnKVxuICAgIC5wcm92aWRlcignJHN5bmMnLCBzeW5jUHJvdmlkZXIpO1xuXG5mdW5jdGlvbiBzeW5jUHJvdmlkZXIoKSB7XG5cbiAgICB2YXIgZGVidWc7XG5cbiAgICB0aGlzLnNldERlYnVnID0gZnVuY3Rpb24gKHZhbHVlKSB7XG4gICAgICAgIGRlYnVnID0gdmFsdWU7XG4gICAgfTtcblxuICAgIHRoaXMuJGdldCA9IGZ1bmN0aW9uIHN5bmMoJHJvb3RTY29wZSwgJHEsICRzb2NrZXRpbywgJHN5bmNHYXJiYWdlQ29sbGVjdG9yLCAkc3luY01lcmdlKSB7XG5cbiAgICAgICAgdmFyIHB1YmxpY2F0aW9uTGlzdGVuZXJzID0ge30sXG4gICAgICAgICAgICBwdWJsaWNhdGlvbkxpc3RlbmVyQ291bnQgPSAwO1xuICAgICAgICB2YXIgR1JBQ0VfUEVSSU9EX0lOX1NFQ09ORFMgPSA4O1xuICAgICAgICB2YXIgU1lOQ19WRVJTSU9OID0gJzEuMic7XG5cblxuICAgICAgICBsaXN0ZW5Ub1N5bmNOb3RpZmljYXRpb24oKTtcblxuICAgICAgICB2YXIgc2VydmljZSA9IHtcbiAgICAgICAgICAgIHN1YnNjcmliZTogc3Vic2NyaWJlLFxuICAgICAgICAgICAgcmVzb2x2ZVN1YnNjcmlwdGlvbjogcmVzb2x2ZVN1YnNjcmlwdGlvbixcbiAgICAgICAgICAgIGdldEdyYWNlUGVyaW9kOiBnZXRHcmFjZVBlcmlvZCxcbiAgICAgICAgICAgIGdldElkVmFsdWU6IGdldElkVmFsdWVcbiAgICAgICAgfTtcblxuICAgICAgICByZXR1cm4gc2VydmljZTtcblxuICAgICAgICAvLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vL1xuICAgICAgICAvKipcbiAgICAgICAgICogc3Vic2NyaWJlIHRvIHB1YmxpY2F0aW9uIGFuZCByZXR1cm5zIHRoZSBzdWJzY3JpcHRpb24gd2hlbiBkYXRhIGlzIGF2YWlsYWJsZS4gXG4gICAgICAgICAqIEBwYXJhbSBwdWJsaWNhdGlvbiBuYW1lLiBvbiB0aGUgc2VydmVyIHNpZGUsIGEgcHVibGljYXRpb24gc2hhbGwgZXhpc3QuIGV4OiBtYWdhemluZXMuc3luY1xuICAgICAgICAgKiBAcGFyYW0gcGFyYW1zICAgdGhlIHBhcmFtcyBvYmplY3QgcGFzc2VkIHRvIHRoZSBzdWJzY3JpcHRpb24sIGV4OiB7bWFnYXppbmVJZDonZW50cmVwcmVuZXVyJ30pXG4gICAgICAgICAqIEBwYXJhbSBvYmplY3RDbGFzcyBhbiBpbnN0YW5jZSBvZiB0aGlzIGNsYXNzIHdpbGwgYmUgY3JlYXRlZCBmb3IgZWFjaCByZWNvcmQgcmVjZWl2ZWQuXG4gICAgICAgICAqIHJldHVybnMgYSBwcm9taXNlIHJldHVybmluZyB0aGUgc3Vic2NyaXB0aW9uIHdoZW4gdGhlIGRhdGEgaXMgc3luY2VkXG4gICAgICAgICAqIG9yIHJlamVjdHMgaWYgdGhlIGluaXRpYWwgc3luYyBmYWlscyB0byBjb21wbGV0ZSBpbiBhIGxpbWl0ZWQgYW1vdW50IG9mIHRpbWUuIFxuICAgICAgICAgKiBcbiAgICAgICAgICogdG8gZ2V0IHRoZSBkYXRhIGZyb20gdGhlIGRhdGFTZXQsIGp1c3QgZGF0YVNldC5nZXREYXRhKClcbiAgICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIHJlc29sdmVTdWJzY3JpcHRpb24ocHVibGljYXRpb25OYW1lLCBwYXJhbXMsIG9iamVjdENsYXNzKSB7XG4gICAgICAgICAgICB2YXIgZGVmZXJyZWQgPSAkcS5kZWZlcigpO1xuICAgICAgICAgICAgdmFyIHNEcyA9IHN1YnNjcmliZShwdWJsaWNhdGlvbk5hbWUpLnNldE9iamVjdENsYXNzKG9iamVjdENsYXNzKTtcblxuICAgICAgICAgICAgLy8gZ2l2ZSBhIGxpdHRsZSB0aW1lIGZvciBzdWJzY3JpcHRpb24gdG8gZmV0Y2ggdGhlIGRhdGEuLi5vdGhlcndpc2UgZ2l2ZSB1cCBzbyB0aGF0IHdlIGRvbid0IGdldCBzdHVjayBpbiBhIHJlc29sdmUgd2FpdGluZyBmb3JldmVyLlxuICAgICAgICAgICAgdmFyIGdyYWNlUGVyaW9kID0gc2V0VGltZW91dChmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgaWYgKCFzRHMucmVhZHkpIHtcbiAgICAgICAgICAgICAgICAgICAgc0RzLmRlc3Ryb3koKTtcbiAgICAgICAgICAgICAgICAgICAgbG9nSW5mbygnQXR0ZW1wdCB0byBzdWJzY3JpYmUgdG8gcHVibGljYXRpb24gJyArIHB1YmxpY2F0aW9uTmFtZSArICcgZmFpbGVkJyk7XG4gICAgICAgICAgICAgICAgICAgIGRlZmVycmVkLnJlamVjdCgnU1lOQ19USU1FT1VUJyk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSwgR1JBQ0VfUEVSSU9EX0lOX1NFQ09ORFMgKiAxMDAwKTtcblxuICAgICAgICAgICAgc0RzLnNldFBhcmFtZXRlcnMocGFyYW1zKVxuICAgICAgICAgICAgICAgIC53YWl0Rm9yRGF0YVJlYWR5KClcbiAgICAgICAgICAgICAgICAudGhlbihmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgICAgIGNsZWFyVGltZW91dChncmFjZVBlcmlvZCk7XG4gICAgICAgICAgICAgICAgICAgIGRlZmVycmVkLnJlc29sdmUoc0RzKTtcbiAgICAgICAgICAgICAgICB9KS5jYXRjaChmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgICAgIGNsZWFyVGltZW91dChncmFjZVBlcmlvZCk7XG4gICAgICAgICAgICAgICAgICAgIHNEcy5kZXN0cm95KCk7XG4gICAgICAgICAgICAgICAgICAgIGRlZmVycmVkLnJlamVjdCgnRmFpbGVkIHRvIHN1YnNjcmliZSB0byBwdWJsaWNhdGlvbiAnICsgcHVibGljYXRpb25OYW1lICsgJyBmYWlsZWQnKTtcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIHJldHVybiBkZWZlcnJlZC5wcm9taXNlO1xuICAgICAgICB9XG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqIFxuICAgICAgICAgKiBmb3IgdGVzdCBwdXJwb3NlcywgcmV0dXJucyB0aGUgdGltZSByZXNvbHZlU3Vic2NyaXB0aW9uIGJlZm9yZSBpdCB0aW1lcyBvdXQuXG4gICAgICAgICAqL1xuICAgICAgICBmdW5jdGlvbiBnZXRHcmFjZVBlcmlvZCgpIHtcbiAgICAgICAgICAgIHJldHVybiBHUkFDRV9QRVJJT0RfSU5fU0VDT05EUztcbiAgICAgICAgfVxuICAgICAgICAvKipcbiAgICAgICAgICogc3Vic2NyaWJlIHRvIHB1YmxpY2F0aW9uLiBJdCB3aWxsIG5vdCBzeW5jIHVudGlsIHlvdSBzZXQgdGhlIHBhcmFtcy5cbiAgICAgICAgICogXG4gICAgICAgICAqIEBwYXJhbSBwdWJsaWNhdGlvbiBuYW1lLiBvbiB0aGUgc2VydmVyIHNpZGUsIGEgcHVibGljYXRpb24gc2hhbGwgZXhpc3QuIGV4OiBtYWdhemluZXMuc3luY1xuICAgICAgICAgKiBAcGFyYW0gcGFyYW1zICAgdGhlIHBhcmFtcyBvYmplY3QgcGFzc2VkIHRvIHRoZSBzdWJzY3JpcHRpb24sIGV4OiB7bWFnYXppbmVJZDonZW50cmVwcmVuZXVyJ30pXG4gICAgICAgICAqIHJldHVybnMgc3Vic2NyaXB0aW9uXG4gICAgICAgICAqIFxuICAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gc3Vic2NyaWJlKHB1YmxpY2F0aW9uTmFtZSwgc2NvcGUpIHtcbiAgICAgICAgICAgIHJldHVybiBuZXcgU3Vic2NyaXB0aW9uKHB1YmxpY2F0aW9uTmFtZSwgc2NvcGUpO1xuICAgICAgICB9XG5cblxuXG4gICAgICAgIC8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vXG4gICAgICAgIC8vIEhFTFBFUlNcblxuICAgICAgICAvLyBldmVyeSBzeW5jIG5vdGlmaWNhdGlvbiBjb21lcyB0aHJ1IHRoZSBzYW1lIGV2ZW50IHRoZW4gaXQgaXMgZGlzcGF0Y2hlcyB0byB0aGUgdGFyZ2V0ZWQgc3Vic2NyaXB0aW9ucy5cbiAgICAgICAgZnVuY3Rpb24gbGlzdGVuVG9TeW5jTm90aWZpY2F0aW9uKCkge1xuICAgICAgICAgICAgJHNvY2tldGlvLm9uKCdTWU5DX05PVycsIGZ1bmN0aW9uIChzdWJOb3RpZmljYXRpb24sIGZuKSB7XG4gICAgICAgICAgICAgICAgbG9nSW5mbygnU3luY2luZyB3aXRoIHN1YnNjcmlwdGlvbiBbbmFtZTonICsgc3ViTm90aWZpY2F0aW9uLm5hbWUgKyAnLCBpZDonICsgc3ViTm90aWZpY2F0aW9uLnN1YnNjcmlwdGlvbklkICsgJyAsIHBhcmFtczonICsgSlNPTi5zdHJpbmdpZnkoc3ViTm90aWZpY2F0aW9uLnBhcmFtcykgKyAnXS4gUmVjb3JkczonICsgc3ViTm90aWZpY2F0aW9uLnJlY29yZHMubGVuZ3RoICsgJ1snICsgKHN1Yk5vdGlmaWNhdGlvbi5kaWZmID8gJ0RpZmYnIDogJ0FsbCcpICsgJ10nKTtcbiAgICAgICAgICAgICAgICB2YXIgbGlzdGVuZXJzID0gcHVibGljYXRpb25MaXN0ZW5lcnNbc3ViTm90aWZpY2F0aW9uLm5hbWVdO1xuICAgICAgICAgICAgICAgIGlmIChsaXN0ZW5lcnMpIHtcbiAgICAgICAgICAgICAgICAgICAgZm9yICh2YXIgbGlzdGVuZXIgaW4gbGlzdGVuZXJzKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsaXN0ZW5lcnNbbGlzdGVuZXJdKHN1Yk5vdGlmaWNhdGlvbik7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgZm4oJ1NZTkNFRCcpOyAvLyBsZXQga25vdyB0aGUgYmFja2VuZCB0aGUgY2xpZW50IHdhcyBhYmxlIHRvIHN5bmMuXG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfTtcblxuXG4gICAgICAgIC8vIHRoaXMgYWxsb3dzIGEgZGF0YXNldCB0byBsaXN0ZW4gdG8gYW55IFNZTkNfTk9XIGV2ZW50Li5hbmQgaWYgdGhlIG5vdGlmaWNhdGlvbiBpcyBhYm91dCBpdHMgZGF0YS5cbiAgICAgICAgZnVuY3Rpb24gYWRkUHVibGljYXRpb25MaXN0ZW5lcihzdHJlYW1OYW1lLCBjYWxsYmFjaykge1xuICAgICAgICAgICAgdmFyIHVpZCA9IHB1YmxpY2F0aW9uTGlzdGVuZXJDb3VudCsrO1xuICAgICAgICAgICAgdmFyIGxpc3RlbmVycyA9IHB1YmxpY2F0aW9uTGlzdGVuZXJzW3N0cmVhbU5hbWVdO1xuICAgICAgICAgICAgaWYgKCFsaXN0ZW5lcnMpIHtcbiAgICAgICAgICAgICAgICBwdWJsaWNhdGlvbkxpc3RlbmVyc1tzdHJlYW1OYW1lXSA9IGxpc3RlbmVycyA9IHt9O1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgbGlzdGVuZXJzW3VpZF0gPSBjYWxsYmFjaztcblxuICAgICAgICAgICAgcmV0dXJuIGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICBkZWxldGUgbGlzdGVuZXJzW3VpZF07XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gICAgICAgIC8vIFN1YnNjcmlwdGlvbiBvYmplY3RcbiAgICAgICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gICAgICAgIC8qKlxuICAgICAgICAgKiBhIHN1YnNjcmlwdGlvbiBzeW5jaHJvbml6ZXMgd2l0aCB0aGUgYmFja2VuZCBmb3IgYW55IGJhY2tlbmQgZGF0YSBjaGFuZ2UgYW5kIG1ha2VzIHRoYXQgZGF0YSBhdmFpbGFibGUgdG8gYSBjb250cm9sbGVyLlxuICAgICAgICAgKiBcbiAgICAgICAgICogIFdoZW4gY2xpZW50IHN1YnNjcmliZXMgdG8gYW4gc3luY3Jvbml6ZWQgYXBpLCBhbnkgZGF0YSBjaGFuZ2UgdGhhdCBpbXBhY3RzIHRoZSBhcGkgcmVzdWx0IFdJTEwgYmUgUFVTSGVkIHRvIHRoZSBjbGllbnQuXG4gICAgICAgICAqIElmIHRoZSBjbGllbnQgZG9lcyBOT1Qgc3Vic2NyaWJlIG9yIHN0b3Agc3Vic2NyaWJlLCBpdCB3aWxsIG5vIGxvbmdlciByZWNlaXZlIHRoZSBQVVNILiBcbiAgICAgICAgICogICAgXG4gICAgICAgICAqIGlmIHRoZSBjb25uZWN0aW9uIGlzIGxvc3QgZm9yIGEgc2hvcnQgdGltZSAoZHVyYXRpb24gZGVmaW5lZCBvbiBzZXJ2ZXItc2lkZSksIHRoZSBzZXJ2ZXIgcXVldWVzIHRoZSBjaGFuZ2VzIGlmIGFueS4gXG4gICAgICAgICAqIFdoZW4gdGhlIGNvbm5lY3Rpb24gcmV0dXJucywgdGhlIG1pc3NpbmcgZGF0YSBhdXRvbWF0aWNhbGx5ICB3aWxsIGJlIFBVU0hlZCB0byB0aGUgc3Vic2NyaWJpbmcgY2xpZW50LlxuICAgICAgICAgKiBpZiB0aGUgY29ubmVjdGlvbiBpcyBsb3N0IGZvciBhIGxvbmcgdGltZSAoZHVyYXRpb24gZGVmaW5lZCBvbiB0aGUgc2VydmVyKSwgdGhlIHNlcnZlciB3aWxsIGRlc3Ryb3kgdGhlIHN1YnNjcmlwdGlvbi4gVG8gc2ltcGxpZnksIHRoZSBjbGllbnQgd2lsbCByZXN1YnNjcmliZSBhdCBpdHMgcmVjb25uZWN0aW9uIGFuZCBnZXQgYWxsIGRhdGEuXG4gICAgICAgICAqIFxuICAgICAgICAgKiBzdWJzY3JpcHRpb24gb2JqZWN0IHByb3ZpZGVzIDMgY2FsbGJhY2tzIChhZGQsdXBkYXRlLCBkZWwpIHdoaWNoIGFyZSBjYWxsZWQgZHVyaW5nIHN5bmNocm9uaXphdGlvbi5cbiAgICAgICAgICogICAgICBcbiAgICAgICAgICogU2NvcGUgd2lsbCBhbGxvdyB0aGUgc3Vic2NyaXB0aW9uIHN0b3Agc3luY2hyb25pemluZyBhbmQgY2FuY2VsIHJlZ2lzdHJhdGlvbiB3aGVuIGl0IGlzIGRlc3Ryb3llZC4gXG4gICAgICAgICAqICBcbiAgICAgICAgICogQ29uc3RydWN0b3I6XG4gICAgICAgICAqIFxuICAgICAgICAgKiBAcGFyYW0gcHVibGljYXRpb24sIHRoZSBwdWJsaWNhdGlvbiBtdXN0IGV4aXN0IG9uIHRoZSBzZXJ2ZXIgc2lkZVxuICAgICAgICAgKiBAcGFyYW0gc2NvcGUsIGJ5IGRlZmF1bHQgJHJvb3RTY29wZSwgYnV0IGNhbiBiZSBtb2RpZmllZCBsYXRlciBvbiB3aXRoIGF0dGFjaCBtZXRob2QuXG4gICAgICAgICAqL1xuXG4gICAgICAgIGZ1bmN0aW9uIFN1YnNjcmlwdGlvbihwdWJsaWNhdGlvbiwgc2NvcGUpIHtcbiAgICAgICAgICAgIHZhciB0aW1lc3RhbXBGaWVsZCwgaXNTeW5jaW5nT24gPSBmYWxzZSwgaXNTaW5nbGUsIHVwZGF0ZURhdGFTdG9yYWdlLCBjYWNoZSwgaXNJbml0aWFsUHVzaENvbXBsZXRlZCwgZGVmZXJyZWRJbml0aWFsaXphdGlvbiwgc3RyaWN0TW9kZTtcbiAgICAgICAgICAgIHZhciBvblJlYWR5T2ZmLCBmb3JtYXRSZWNvcmQ7XG4gICAgICAgICAgICB2YXIgcmVjb25uZWN0T2ZmLCBwdWJsaWNhdGlvbkxpc3RlbmVyT2ZmLCBkZXN0cm95T2ZmO1xuICAgICAgICAgICAgdmFyIG9iamVjdENsYXNzO1xuICAgICAgICAgICAgdmFyIHN1YnNjcmlwdGlvbklkO1xuXG4gICAgICAgICAgICB2YXIgc0RzID0gdGhpcztcbiAgICAgICAgICAgIHZhciBzdWJQYXJhbXMgPSB7fTtcbiAgICAgICAgICAgIHZhciByZWNvcmRTdGF0ZXMgPSB7fTtcbiAgICAgICAgICAgIHZhciBpbm5lclNjb3BlOy8vPSAkcm9vdFNjb3BlLiRuZXcodHJ1ZSk7XG4gICAgICAgICAgICB2YXIgc3luY0xpc3RlbmVyID0gbmV3IFN5bmNMaXN0ZW5lcigpO1xuXG5cbiAgICAgICAgICAgIHRoaXMucmVhZHkgPSBmYWxzZTtcbiAgICAgICAgICAgIHRoaXMuc3luY09uID0gc3luY09uO1xuICAgICAgICAgICAgdGhpcy5zeW5jT2ZmID0gc3luY09mZjtcbiAgICAgICAgICAgIHRoaXMuc2V0T25SZWFkeSA9IHNldE9uUmVhZHk7XG5cbiAgICAgICAgICAgIHRoaXMub25SZWFkeSA9IG9uUmVhZHk7XG4gICAgICAgICAgICB0aGlzLm9uVXBkYXRlID0gb25VcGRhdGU7XG4gICAgICAgICAgICB0aGlzLm9uQWRkID0gb25BZGQ7XG4gICAgICAgICAgICB0aGlzLm9uUmVtb3ZlID0gb25SZW1vdmU7XG5cbiAgICAgICAgICAgIHRoaXMuZ2V0RGF0YSA9IGdldERhdGE7XG4gICAgICAgICAgICB0aGlzLnNldFBhcmFtZXRlcnMgPSBzZXRQYXJhbWV0ZXJzO1xuXG4gICAgICAgICAgICB0aGlzLndhaXRGb3JEYXRhUmVhZHkgPSB3YWl0Rm9yRGF0YVJlYWR5O1xuICAgICAgICAgICAgdGhpcy53YWl0Rm9yU3Vic2NyaXB0aW9uUmVhZHkgPSB3YWl0Rm9yU3Vic2NyaXB0aW9uUmVhZHk7XG5cbiAgICAgICAgICAgIHRoaXMuc2V0Rm9yY2UgPSBzZXRGb3JjZTtcbiAgICAgICAgICAgIHRoaXMuaXNTeW5jaW5nID0gaXNTeW5jaW5nO1xuICAgICAgICAgICAgdGhpcy5pc1JlYWR5ID0gaXNSZWFkeTtcblxuICAgICAgICAgICAgdGhpcy5zZXRTaW5nbGUgPSBzZXRTaW5nbGU7XG5cbiAgICAgICAgICAgIHRoaXMuc2V0T2JqZWN0Q2xhc3MgPSBzZXRPYmplY3RDbGFzcztcbiAgICAgICAgICAgIHRoaXMuZ2V0T2JqZWN0Q2xhc3MgPSBnZXRPYmplY3RDbGFzcztcblxuICAgICAgICAgICAgdGhpcy5zZXRTdHJpY3RNb2RlID0gc2V0U3RyaWN0TW9kZTtcblxuICAgICAgICAgICAgdGhpcy5hdHRhY2ggPSBhdHRhY2g7XG4gICAgICAgICAgICB0aGlzLmRlc3Ryb3kgPSBkZXN0cm95O1xuXG4gICAgICAgICAgICB0aGlzLmlzRXhpc3RpbmdTdGF0ZUZvciA9IGlzRXhpc3RpbmdTdGF0ZUZvcjsgLy8gZm9yIHRlc3RpbmcgcHVycG9zZXNcblxuICAgICAgICAgICAgc2V0U2luZ2xlKGZhbHNlKTtcblxuICAgICAgICAgICAgLy8gdGhpcyB3aWxsIG1ha2Ugc3VyZSB0aGF0IHRoZSBzdWJzY3JpcHRpb24gaXMgcmVsZWFzZWQgZnJvbSBzZXJ2ZXJzIGlmIHRoZSBhcHAgY2xvc2VzIChjbG9zZSBicm93c2VyLCByZWZyZXNoLi4uKVxuICAgICAgICAgICAgYXR0YWNoKHNjb3BlIHx8ICRyb290U2NvcGUpO1xuXG4gICAgICAgICAgICAvLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vXG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIGRlc3Ryb3koKSB7XG4gICAgICAgICAgICAgICAgc3luY09mZigpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvKiogdGhpcyB3aWxsIGJlIGNhbGxlZCB3aGVuIGRhdGEgaXMgYXZhaWxhYmxlIFxuICAgICAgICAgICAgICogIGl0IG1lYW5zIHJpZ2h0IGFmdGVyIGVhY2ggc3luYyFcbiAgICAgICAgICAgICAqIFxuICAgICAgICAgICAgICogXG4gICAgICAgICAgICAqL1xuICAgICAgICAgICAgZnVuY3Rpb24gc2V0T25SZWFkeShjYWxsYmFjaykge1xuICAgICAgICAgICAgICAgIGlmIChvblJlYWR5T2ZmKSB7XG4gICAgICAgICAgICAgICAgICAgIG9uUmVhZHlPZmYoKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgb25SZWFkeU9mZiA9IG9uUmVhZHkoY2FsbGJhY2spO1xuICAgICAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogZm9yY2UgcmVzeW5jaW5nIGZyb20gc2NyYXRjaCBldmVuIGlmIHRoZSBwYXJhbWV0ZXJzIGhhdmUgbm90IGNoYW5nZWRcbiAgICAgICAgICAgICAqIFxuICAgICAgICAgICAgICogaWYgb3V0c2lkZSBjb2RlIGhhcyBtb2RpZmllZCB0aGUgZGF0YSBhbmQgeW91IG5lZWQgdG8gcm9sbGJhY2ssIHlvdSBjb3VsZCBjb25zaWRlciBmb3JjaW5nIGEgcmVmcmVzaCB3aXRoIHRoaXMuIEJldHRlciBzb2x1dGlvbiBzaG91bGQgYmUgZm91bmQgdGhhbiB0aGF0LlxuICAgICAgICAgICAgICogXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIHNldEZvcmNlKHZhbHVlKSB7XG4gICAgICAgICAgICAgICAgaWYgKHZhbHVlKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIHF1aWNrIGhhY2sgdG8gZm9yY2UgdG8gcmVsb2FkLi4ucmVjb2RlIGxhdGVyLlxuICAgICAgICAgICAgICAgICAgICBzRHMuc3luY09mZigpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqIGlmIHNldCB0byB0cnVlLCBpZiBhbiBvYmplY3Qgd2l0aGluIGFuIGFycmF5IHByb3BlcnR5IG9mIHRoZSByZWNvcmQgdG8gc3luYyBoYXMgbm8gSUQgZmllbGQuXG4gICAgICAgICAgICAgKiBhbiBlcnJvciB3b3VsZCBiZSB0aHJvd24uXG4gICAgICAgICAgICAgKiBJdCBpcyBpbXBvcnRhbnQgaWYgd2Ugd2FudCB0byBiZSBhYmxlIHRvIG1haW50YWluIGluc3RhbmNlIHJlZmVyZW5jZXMgZXZlbiBmb3IgdGhlIG9iamVjdHMgaW5zaWRlIGFycmF5cy5cbiAgICAgICAgICAgICAqXG4gICAgICAgICAgICAgKiBGb3JjZXMgdXMgdG8gdXNlIGlkIGV2ZXJ5IHdoZXJlLlxuICAgICAgICAgICAgICpcbiAgICAgICAgICAgICAqIFNob3VsZCBiZSB0aGUgZGVmYXVsdC4uLmJ1dCB0b28gcmVzdHJpY3RpdmUgZm9yIG5vdy5cbiAgICAgICAgICAgICAqL1xuICAgICAgICAgICAgZnVuY3Rpb24gc2V0U3RyaWN0TW9kZSh2YWx1ZSkge1xuICAgICAgICAgICAgICAgIHN0cmljdE1vZGUgPSB2YWx1ZTtcbiAgICAgICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqIFRoZSBmb2xsb3dpbmcgb2JqZWN0IHdpbGwgYmUgYnVpbHQgdXBvbiBlYWNoIHJlY29yZCByZWNlaXZlZCBmcm9tIHRoZSBiYWNrZW5kXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICAqIFRoaXMgY2Fubm90IGJlIG1vZGlmaWVkIGFmdGVyIHRoZSBzeW5jIGhhcyBzdGFydGVkLlxuICAgICAgICAgICAgICogXG4gICAgICAgICAgICAgKiBAcGFyYW0gY2xhc3NWYWx1ZVxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBzZXRPYmplY3RDbGFzcyhjbGFzc1ZhbHVlKSB7XG4gICAgICAgICAgICAgICAgaWYgKGRlZmVycmVkSW5pdGlhbGl6YXRpb24pIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICBvYmplY3RDbGFzcyA9IGNsYXNzVmFsdWU7XG4gICAgICAgICAgICAgICAgZm9ybWF0UmVjb3JkID0gZnVuY3Rpb24gKHJlY29yZCkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gbmV3IG9iamVjdENsYXNzKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHNldFNpbmdsZShpc1NpbmdsZSk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gZ2V0T2JqZWN0Q2xhc3MoKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIG9iamVjdENsYXNzO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqIHRoaXMgZnVuY3Rpb24gc3RhcnRzIHRoZSBzeW5jaW5nLlxuICAgICAgICAgICAgICogT25seSBwdWJsaWNhdGlvbiBwdXNoaW5nIGRhdGEgbWF0Y2hpbmcgb3VyIGZldGNoaW5nIHBhcmFtcyB3aWxsIGJlIHJlY2VpdmVkLlxuICAgICAgICAgICAgICogXG4gICAgICAgICAgICAgKiBleDogZm9yIGEgcHVibGljYXRpb24gbmFtZWQgXCJtYWdhemluZXMuc3luY1wiLCBpZiBmZXRjaGluZyBwYXJhbXMgZXF1YWxsZWQge21hZ2F6aW5OYW1lOidjYXJzJ30sIHRoZSBtYWdhemluZSBjYXJzIGRhdGEgd291bGQgYmUgcmVjZWl2ZWQgYnkgdGhpcyBzdWJzY3JpcHRpb24uXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICAqIEBwYXJhbSBmZXRjaGluZ1BhcmFtc1xuICAgICAgICAgICAgICogQHBhcmFtIG9wdGlvbnNcbiAgICAgICAgICAgICAqIFxuICAgICAgICAgICAgICogQHJldHVybnMgYSBwcm9taXNlIHRoYXQgcmVzb2x2ZXMgd2hlbiBkYXRhIGlzIGFycml2ZWQuXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIHNldFBhcmFtZXRlcnMoZmV0Y2hpbmdQYXJhbXMsIG9wdGlvbnMpIHtcbiAgICAgICAgICAgICAgICBpZiAoaXNTeW5jaW5nT24gJiYgYW5ndWxhci5lcXVhbHMoZmV0Y2hpbmdQYXJhbXMgfHwge30sIHN1YlBhcmFtcykpIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gaWYgdGhlIHBhcmFtcyBoYXZlIG5vdCBjaGFuZ2VkLCBqdXN0IHJldHVybnMgd2l0aCBjdXJyZW50IGRhdGEuXG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBzRHM7IC8vJHEucmVzb2x2ZShnZXREYXRhKCkpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBzeW5jT2ZmKCk7XG4gICAgICAgICAgICAgICAgaWYgKCFpc1NpbmdsZSkge1xuICAgICAgICAgICAgICAgICAgICBjYWNoZS5sZW5ndGggPSAwO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHN1YlBhcmFtcyA9IGZldGNoaW5nUGFyYW1zIHx8IHt9O1xuICAgICAgICAgICAgICAgIG9wdGlvbnMgPSBvcHRpb25zIHx8IHt9O1xuICAgICAgICAgICAgICAgIGlmIChhbmd1bGFyLmlzRGVmaW5lZChvcHRpb25zLnNpbmdsZSkpIHtcbiAgICAgICAgICAgICAgICAgICAgc2V0U2luZ2xlKG9wdGlvbnMuc2luZ2xlKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgc3RhcnRTeW5jaW5nKCk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgKiBAcmV0dXJucyBhIHByb21pc2UgdGhhdCB3YWl0cyBmb3IgdGhlIGluaXRpYWwgZmV0Y2ggdG8gY29tcGxldGUgdGhlbiB3YWl0IGZvciB0aGUgaW5pdGlhbCBmZXRjaCB0byBjb21wbGV0ZSB0aGVuIHJldHVybnMgdGhpcyBzdWJzY3JpcHRpb24uXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIHdhaXRGb3JTdWJzY3JpcHRpb25SZWFkeSgpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gc3RhcnRTeW5jaW5nKCkudGhlbihmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogQHJldHVybnMgYSBwcm9taXNlIHRoYXQgd2FpdHMgZm9yIHRoZSBpbml0aWFsIGZldGNoIHRvIGNvbXBsZXRlIHRoZW4gcmV0dXJucyB0aGUgZGF0YVxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiB3YWl0Rm9yRGF0YVJlYWR5KCkge1xuICAgICAgICAgICAgICAgIHJldHVybiBzdGFydFN5bmNpbmcoKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy8gZG9lcyB0aGUgZGF0YXNldCByZXR1cm5zIG9ubHkgb25lIG9iamVjdD8gbm90IGFuIGFycmF5P1xuICAgICAgICAgICAgZnVuY3Rpb24gc2V0U2luZ2xlKHZhbHVlKSB7XG4gICAgICAgICAgICAgICAgaWYgKGRlZmVycmVkSW5pdGlhbGl6YXRpb24pIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICB2YXIgdXBkYXRlRm47XG4gICAgICAgICAgICAgICAgaXNTaW5nbGUgPSB2YWx1ZTtcbiAgICAgICAgICAgICAgICBpZiAodmFsdWUpIHtcbiAgICAgICAgICAgICAgICAgICAgdXBkYXRlRm4gPSB1cGRhdGVTeW5jZWRPYmplY3Q7XG4gICAgICAgICAgICAgICAgICAgIGNhY2hlID0gb2JqZWN0Q2xhc3MgPyBuZXcgb2JqZWN0Q2xhc3Moe30pIDoge307XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgdXBkYXRlRm4gPSB1cGRhdGVTeW5jZWRBcnJheTtcbiAgICAgICAgICAgICAgICAgICAgY2FjaGUgPSBbXTtcbiAgICAgICAgICAgICAgICB9XG5cbiAgICAgICAgICAgICAgICB1cGRhdGVEYXRhU3RvcmFnZSA9IGZ1bmN0aW9uIChyZWNvcmQpIHtcbiAgICAgICAgICAgICAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHVwZGF0ZUZuKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgIH0gY2F0Y2ggKGUpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGUubWVzc2FnZSA9ICdSZWNlaXZlZCBJbnZhbGlkIG9iamVjdCBmcm9tIHB1YmxpY2F0aW9uIFsnICsgcHVibGljYXRpb24gKyAnXTogJyArIEpTT04uc3RyaW5naWZ5KHJlY29yZCkgKyAnLiBERVRBSUxTOiAnICsgZS5tZXNzYWdlO1xuICAgICAgICAgICAgICAgICAgICAgICAgdGhyb3cgZTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIHJldHVybnMgdGhlIG9iamVjdCBvciBhcnJheSBpbiBzeW5jXG4gICAgICAgICAgICBmdW5jdGlvbiBnZXREYXRhKCkge1xuICAgICAgICAgICAgICAgIHJldHVybiBjYWNoZTtcbiAgICAgICAgICAgIH1cblxuXG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqIEFjdGl2YXRlIHN5bmNpbmdcbiAgICAgICAgICAgICAqXG4gICAgICAgICAgICAgKiBAcmV0dXJucyB0aGlzIHN1YmNyaXB0aW9uXG4gICAgICAgICAgICAgKlxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBzeW5jT24oKSB7XG4gICAgICAgICAgICAgICAgc3RhcnRTeW5jaW5nKCk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgICAgIH1cblxuXG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqIERlYWN0aXZhdGUgc3luY2luZ1xuICAgICAgICAgICAgICpcbiAgICAgICAgICAgICAqIHRoZSBkYXRhc2V0IGlzIG5vIGxvbmdlciBsaXN0ZW5pbmcgYW5kIHdpbGwgbm90IGNhbGwgYW55IGNhbGxiYWNrXG4gICAgICAgICAgICAgKlxuICAgICAgICAgICAgICogQHJldHVybnMgdGhpcyBzdWJjcmlwdGlvblxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBzeW5jT2ZmKCkge1xuICAgICAgICAgICAgICAgIGlmIChkZWZlcnJlZEluaXRpYWxpemF0aW9uKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIGlmIHRoZXJlIGlzIGNvZGUgd2FpdGluZyBvbiB0aGlzIHByb21pc2UuLiBleCAobG9hZCBpbiByZXNvbHZlKVxuICAgICAgICAgICAgICAgICAgICBkZWZlcnJlZEluaXRpYWxpemF0aW9uLnJlc29sdmUoZ2V0RGF0YSgpKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgaWYgKGlzU3luY2luZ09uKSB7XG4gICAgICAgICAgICAgICAgICAgIHVucmVnaXN0ZXJTdWJzY3JpcHRpb24oKTtcbiAgICAgICAgICAgICAgICAgICAgaXNTeW5jaW5nT24gPSBmYWxzZTtcblxuICAgICAgICAgICAgICAgICAgICBsb2dJbmZvKCdTeW5jICcgKyBwdWJsaWNhdGlvbiArICcgb2ZmLiBQYXJhbXM6JyArIEpTT04uc3RyaW5naWZ5KHN1YlBhcmFtcykpO1xuICAgICAgICAgICAgICAgICAgICBpZiAocHVibGljYXRpb25MaXN0ZW5lck9mZikge1xuICAgICAgICAgICAgICAgICAgICAgICAgcHVibGljYXRpb25MaXN0ZW5lck9mZigpO1xuICAgICAgICAgICAgICAgICAgICAgICAgcHVibGljYXRpb25MaXN0ZW5lck9mZiA9IG51bGw7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgaWYgKHJlY29ubmVjdE9mZikge1xuICAgICAgICAgICAgICAgICAgICAgICAgcmVjb25uZWN0T2ZmKCk7XG4gICAgICAgICAgICAgICAgICAgICAgICByZWNvbm5lY3RPZmYgPSBudWxsO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogdGhlIGRhdGFzZXQgd2lsbCBzdGFydCBsaXN0ZW5pbmcgdG8gdGhlIGRhdGFzdHJlYW0gXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICAqIE5vdGUgRHVyaW5nIHRoZSBzeW5jLCBpdCB3aWxsIGFsc28gY2FsbCB0aGUgb3B0aW9uYWwgY2FsbGJhY2tzIC0gYWZ0ZXIgcHJvY2Vzc2luZyBFQUNIIHJlY29yZCByZWNlaXZlZC5cbiAgICAgICAgICAgICAqIFxuICAgICAgICAgICAgICogQHJldHVybnMgYSBwcm9taXNlIHRoYXQgd2lsbCBiZSByZXNvbHZlZCB3aGVuIHRoZSBkYXRhIGlzIHJlYWR5LlxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBzdGFydFN5bmNpbmcoKSB7XG4gICAgICAgICAgICAgICAgaWYgKGlzU3luY2luZ09uKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBkZWZlcnJlZEluaXRpYWxpemF0aW9uLnByb21pc2U7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGRlZmVycmVkSW5pdGlhbGl6YXRpb24gPSAkcS5kZWZlcigpO1xuICAgICAgICAgICAgICAgIGlzSW5pdGlhbFB1c2hDb21wbGV0ZWQgPSBmYWxzZTtcbiAgICAgICAgICAgICAgICBsb2dJbmZvKCdTeW5jICcgKyBwdWJsaWNhdGlvbiArICcgb24uIFBhcmFtczonICsgSlNPTi5zdHJpbmdpZnkoc3ViUGFyYW1zKSk7XG4gICAgICAgICAgICAgICAgaXNTeW5jaW5nT24gPSB0cnVlO1xuICAgICAgICAgICAgICAgIHJlZ2lzdGVyU3Vic2NyaXB0aW9uKCk7XG4gICAgICAgICAgICAgICAgcmVhZHlGb3JMaXN0ZW5pbmcoKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gZGVmZXJyZWRJbml0aWFsaXphdGlvbi5wcm9taXNlO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBpc1N5bmNpbmcoKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGlzU3luY2luZ09uO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiByZWFkeUZvckxpc3RlbmluZygpIHtcbiAgICAgICAgICAgICAgICBpZiAoIXB1YmxpY2F0aW9uTGlzdGVuZXJPZmYpIHtcbiAgICAgICAgICAgICAgICAgICAgbGlzdGVuRm9yUmVjb25uZWN0aW9uVG9SZXN5bmMoKTtcbiAgICAgICAgICAgICAgICAgICAgbGlzdGVuVG9QdWJsaWNhdGlvbigpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgKiAgQnkgZGVmYXVsdCB0aGUgcm9vdHNjb3BlIGlzIGF0dGFjaGVkIGlmIG5vIHNjb3BlIHdhcyBwcm92aWRlZC4gQnV0IGl0IGlzIHBvc3NpYmxlIHRvIHJlLWF0dGFjaCBpdCB0byBhIGRpZmZlcmVudCBzY29wZS4gaWYgdGhlIHN1YnNjcmlwdGlvbiBkZXBlbmRzIG9uIGEgY29udHJvbGxlci5cbiAgICAgICAgICAgICAqXG4gICAgICAgICAgICAgKiAgRG8gbm90IGF0dGFjaCBhZnRlciBpdCBoYXMgc3luY2VkLlxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBhdHRhY2gobmV3U2NvcGUpIHtcbiAgICAgICAgICAgICAgICBpZiAoZGVmZXJyZWRJbml0aWFsaXphdGlvbikge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBpZiAoZGVzdHJveU9mZikge1xuICAgICAgICAgICAgICAgICAgICBkZXN0cm95T2ZmKCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGlubmVyU2NvcGUgPSBuZXdTY29wZTtcbiAgICAgICAgICAgICAgICBkZXN0cm95T2ZmID0gaW5uZXJTY29wZS4kb24oJyRkZXN0cm95JywgZGVzdHJveSk7XG5cbiAgICAgICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBsaXN0ZW5Gb3JSZWNvbm5lY3Rpb25Ub1Jlc3luYyhsaXN0ZW5Ob3cpIHtcbiAgICAgICAgICAgICAgICAvLyBnaXZlIGEgY2hhbmNlIHRvIGNvbm5lY3QgYmVmb3JlIGxpc3RlbmluZyB0byByZWNvbm5lY3Rpb24uLi4gQFRPRE8gc2hvdWxkIGhhdmUgdXNlcl9yZWNvbm5lY3RlZF9ldmVudFxuICAgICAgICAgICAgICAgIHNldFRpbWVvdXQoZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgICAgICByZWNvbm5lY3RPZmYgPSBpbm5lclNjb3BlLiRvbigndXNlcl9jb25uZWN0ZWQnLCBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBsb2dEZWJ1ZygnUmVzeW5jaW5nIGFmdGVyIG5ldHdvcmsgbG9zcyB0byAnICsgcHVibGljYXRpb24pO1xuICAgICAgICAgICAgICAgICAgICAgICAgLy8gbm90ZSB0aGUgYmFja2VuZCBtaWdodCByZXR1cm4gYSBuZXcgc3Vic2NyaXB0aW9uIGlmIHRoZSBjbGllbnQgdG9vayB0b28gbXVjaCB0aW1lIHRvIHJlY29ubmVjdC5cbiAgICAgICAgICAgICAgICAgICAgICAgIHJlZ2lzdGVyU3Vic2NyaXB0aW9uKCk7XG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIH0sIGxpc3Rlbk5vdyA/IDAgOiAyMDAwKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gcmVnaXN0ZXJTdWJzY3JpcHRpb24oKSB7XG4gICAgICAgICAgICAgICAgJHNvY2tldGlvLmZldGNoKCdzeW5jLnN1YnNjcmliZScsIHtcbiAgICAgICAgICAgICAgICAgICAgdmVyc2lvbjogU1lOQ19WRVJTSU9OLFxuICAgICAgICAgICAgICAgICAgICBpZDogc3Vic2NyaXB0aW9uSWQsIC8vIHRvIHRyeSB0byByZS11c2UgZXhpc3Rpbmcgc3ViY3JpcHRpb25cbiAgICAgICAgICAgICAgICAgICAgcHVibGljYXRpb246IHB1YmxpY2F0aW9uLFxuICAgICAgICAgICAgICAgICAgICBwYXJhbXM6IHN1YlBhcmFtc1xuICAgICAgICAgICAgICAgIH0pLnRoZW4oZnVuY3Rpb24gKHN1YklkKSB7XG4gICAgICAgICAgICAgICAgICAgIHN1YnNjcmlwdGlvbklkID0gc3ViSWQ7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIHVucmVnaXN0ZXJTdWJzY3JpcHRpb24oKSB7XG4gICAgICAgICAgICAgICAgaWYgKHN1YnNjcmlwdGlvbklkKSB7XG4gICAgICAgICAgICAgICAgICAgICRzb2NrZXRpby5mZXRjaCgnc3luYy51bnN1YnNjcmliZScsIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHZlcnNpb246IFNZTkNfVkVSU0lPTixcbiAgICAgICAgICAgICAgICAgICAgICAgIGlkOiBzdWJzY3JpcHRpb25JZFxuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICAgICAgc3Vic2NyaXB0aW9uSWQgPSBudWxsO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gbGlzdGVuVG9QdWJsaWNhdGlvbigpIHtcbiAgICAgICAgICAgICAgICAvLyBjYW5ub3Qgb25seSBsaXN0ZW4gdG8gc3Vic2NyaXB0aW9uSWQgeWV0Li4uYmVjYXVzZSB0aGUgcmVnaXN0cmF0aW9uIG1pZ2h0IGhhdmUgYW5zd2VyIHByb3ZpZGVkIGl0cyBpZCB5ZXQuLi5idXQgc3RhcnRlZCBicm9hZGNhc3RpbmcgY2hhbmdlcy4uLkBUT0RPIGNhbiBiZSBpbXByb3ZlZC4uLlxuICAgICAgICAgICAgICAgIHB1YmxpY2F0aW9uTGlzdGVuZXJPZmYgPSBhZGRQdWJsaWNhdGlvbkxpc3RlbmVyKHB1YmxpY2F0aW9uLCBmdW5jdGlvbiAoYmF0Y2gpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHN1YnNjcmlwdGlvbklkID09PSBiYXRjaC5zdWJzY3JpcHRpb25JZCB8fCAoIXN1YnNjcmlwdGlvbklkICYmIGNoZWNrRGF0YVNldFBhcmFtc0lmTWF0Y2hpbmdCYXRjaFBhcmFtcyhiYXRjaC5wYXJhbXMpKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFiYXRjaC5kaWZmKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgLy8gQ2xlYXIgdGhlIGNhY2hlIHRvIHJlYnVpbGQgaXQgaWYgYWxsIGRhdGEgd2FzIHJlY2VpdmVkLlxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlY29yZFN0YXRlcyA9IHt9O1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlmICghaXNTaW5nbGUpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FjaGUubGVuZ3RoID0gMDtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICBhcHBseUNoYW5nZXMoYmF0Y2gucmVjb3Jkcyk7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWlzSW5pdGlhbFB1c2hDb21wbGV0ZWQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpc0luaXRpYWxQdXNoQ29tcGxldGVkID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBkZWZlcnJlZEluaXRpYWxpemF0aW9uLnJlc29sdmUoZ2V0RGF0YSgpKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICogaWYgdGhlIHBhcmFtcyBvZiB0aGUgZGF0YXNldCBtYXRjaGVzIHRoZSBub3RpZmljYXRpb24sIGl0IG1lYW5zIHRoZSBkYXRhIG5lZWRzIHRvIGJlIGNvbGxlY3QgdG8gdXBkYXRlIGFycmF5LlxuICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIGNoZWNrRGF0YVNldFBhcmFtc0lmTWF0Y2hpbmdCYXRjaFBhcmFtcyhiYXRjaFBhcmFtcykge1xuICAgICAgICAgICAgICAgIC8vIGlmIChwYXJhbXMubGVuZ3RoICE9IHN0cmVhbVBhcmFtcy5sZW5ndGgpIHtcbiAgICAgICAgICAgICAgICAvLyAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgICAgIC8vIH1cbiAgICAgICAgICAgICAgICBpZiAoIXN1YlBhcmFtcyB8fCBPYmplY3Qua2V5cyhzdWJQYXJhbXMpLmxlbmd0aCA9PSAwKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiB0cnVlXG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHZhciBtYXRjaGluZyA9IHRydWU7XG4gICAgICAgICAgICAgICAgZm9yICh2YXIgcGFyYW0gaW4gYmF0Y2hQYXJhbXMpIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gYXJlIG90aGVyIHBhcmFtcyBtYXRjaGluZz9cbiAgICAgICAgICAgICAgICAgICAgLy8gZXg6IHdlIG1pZ2h0IGhhdmUgcmVjZWl2ZSBhIG5vdGlmaWNhdGlvbiBhYm91dCB0YXNrSWQ9MjAgYnV0IHRoaXMgc3Vic2NyaXB0aW9uIGFyZSBvbmx5IGludGVyZXN0ZWQgYWJvdXQgdGFza0lkLTNcbiAgICAgICAgICAgICAgICAgICAgaWYgKGJhdGNoUGFyYW1zW3BhcmFtXSAhPT0gc3ViUGFyYW1zW3BhcmFtXSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgbWF0Y2hpbmcgPSBmYWxzZTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHJldHVybiBtYXRjaGluZztcblxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyBmZXRjaCBhbGwgdGhlIG1pc3NpbmcgcmVjb3JkcywgYW5kIGFjdGl2YXRlIHRoZSBjYWxsIGJhY2tzIChhZGQsdXBkYXRlLHJlbW92ZSkgYWNjb3JkaW5nbHkgaWYgdGhlcmUgaXMgc29tZXRoaW5nIHRoYXQgaXMgbmV3IG9yIG5vdCBhbHJlYWR5IGluIHN5bmMuXG4gICAgICAgICAgICBmdW5jdGlvbiBhcHBseUNoYW5nZXMocmVjb3Jkcykge1xuICAgICAgICAgICAgICAgIHZhciBuZXdEYXRhQXJyYXkgPSBbXTtcbiAgICAgICAgICAgICAgICB2YXIgbmV3RGF0YTtcbiAgICAgICAgICAgICAgICBzRHMucmVhZHkgPSBmYWxzZTtcbiAgICAgICAgICAgICAgICByZWNvcmRzLmZvckVhY2goZnVuY3Rpb24gKHJlY29yZCkge1xuICAgICAgICAgICAgICAgICAgICAvLyAgICAgICAgICAgICAgICAgICBsb2dJbmZvKCdEYXRhc3luYyBbJyArIGRhdGFTdHJlYW1OYW1lICsgJ10gcmVjZWl2ZWQ6JyArSlNPTi5zdHJpbmdpZnkocmVjb3JkKSk7Ly8rIEpTT04uc3RyaW5naWZ5KHJlY29yZC5pZCkpO1xuICAgICAgICAgICAgICAgICAgICBpZiAocmVjb3JkLnJlbW92ZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgcmVtb3ZlUmVjb3JkKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAoZ2V0UmVjb3JkU3RhdGUocmVjb3JkKSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy8gaWYgdGhlIHJlY29yZCBpcyBhbHJlYWR5IHByZXNlbnQgaW4gdGhlIGNhY2hlLi4uc28gaXQgaXMgbWlnaHRiZSBhbiB1cGRhdGUuLlxuICAgICAgICAgICAgICAgICAgICAgICAgbmV3RGF0YSA9IHVwZGF0ZVJlY29yZChyZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgbmV3RGF0YSA9IGFkZFJlY29yZChyZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIGlmIChuZXdEYXRhKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBuZXdEYXRhQXJyYXkucHVzaChuZXdEYXRhKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIHNEcy5yZWFkeSA9IHRydWU7XG4gICAgICAgICAgICAgICAgaWYgKGlzU2luZ2xlKSB7XG4gICAgICAgICAgICAgICAgICAgIHN5bmNMaXN0ZW5lci5ub3RpZnkoJ3JlYWR5JywgZ2V0RGF0YSgpKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBzeW5jTGlzdGVuZXIubm90aWZ5KCdyZWFkeScsIGdldERhdGEoKSwgbmV3RGF0YUFycmF5KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogQWx0aG91Z2ggbW9zdCBjYXNlcyBhcmUgaGFuZGxlZCB1c2luZyBvblJlYWR5LCB0aGlzIHRlbGxzIHlvdSB0aGUgY3VycmVudCBkYXRhIHN0YXRlLlxuICAgICAgICAgICAgICogXG4gICAgICAgICAgICAgKiBAcmV0dXJucyBpZiB0cnVlIGlzIGEgc3luYyBoYXMgYmVlbiBwcm9jZXNzZWQgb3RoZXJ3aXNlIGZhbHNlIGlmIHRoZSBkYXRhIGlzIG5vdCByZWFkeS5cbiAgICAgICAgICAgICAqL1xuICAgICAgICAgICAgZnVuY3Rpb24gaXNSZWFkeSgpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdGhpcy5yZWFkeTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogXG4gICAgICAgICAgICAgKiByZXR1cm5zIGEgZnVuY3Rpb24gdG8gcmVtb3ZlIHRoZSBsaXN0ZW5lci5cbiAgICAgICAgICAgICAqL1xuICAgICAgICAgICAgZnVuY3Rpb24gb25BZGQoY2FsbGJhY2spIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gc3luY0xpc3RlbmVyLm9uKCdhZGQnLCBjYWxsYmFjayk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogXG4gICAgICAgICAgICAgKiByZXR1cm5zIGEgZnVuY3Rpb24gdG8gcmVtb3ZlIHRoZSBsaXN0ZW5lci5cbiAgICAgICAgICAgICAqL1xuICAgICAgICAgICAgZnVuY3Rpb24gb25VcGRhdGUoY2FsbGJhY2spIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gc3luY0xpc3RlbmVyLm9uKCd1cGRhdGUnLCBjYWxsYmFjayk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogXG4gICAgICAgICAgICAgKiByZXR1cm5zIGEgZnVuY3Rpb24gdG8gcmVtb3ZlIHRoZSBsaXN0ZW5lci5cbiAgICAgICAgICAgICAqL1xuICAgICAgICAgICAgZnVuY3Rpb24gb25SZW1vdmUoY2FsbGJhY2spIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gc3luY0xpc3RlbmVyLm9uKCdyZW1vdmUnLCBjYWxsYmFjayk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogXG4gICAgICAgICAgICAgKiByZXR1cm5zIGEgZnVuY3Rpb24gdG8gcmVtb3ZlIHRoZSBsaXN0ZW5lci5cbiAgICAgICAgICAgICAqL1xuICAgICAgICAgICAgZnVuY3Rpb24gb25SZWFkeShjYWxsYmFjaykge1xuICAgICAgICAgICAgICAgIHJldHVybiBzeW5jTGlzdGVuZXIub24oJ3JlYWR5JywgY2FsbGJhY2spO1xuICAgICAgICAgICAgfVxuXG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIGFkZFJlY29yZChyZWNvcmQpIHtcbiAgICAgICAgICAgICAgICBsb2dEZWJ1ZygnU3luYyAtPiBJbnNlcnRlZCBOZXcgcmVjb3JkICMnICsgSlNPTi5zdHJpbmdpZnkocmVjb3JkLmlkKSArICcgZm9yIHN1YnNjcmlwdGlvbiB0byAnICsgcHVibGljYXRpb24pOy8vIEpTT04uc3RyaW5naWZ5KHJlY29yZCkpO1xuICAgICAgICAgICAgICAgIGdldFJldmlzaW9uKHJlY29yZCk7IC8vIGp1c3QgbWFrZSBzdXJlIHdlIGNhbiBnZXQgYSByZXZpc2lvbiBiZWZvcmUgd2UgaGFuZGxlIHRoaXMgcmVjb3JkXG4gICAgICAgICAgICAgICAgdXBkYXRlRGF0YVN0b3JhZ2UoZm9ybWF0UmVjb3JkID8gZm9ybWF0UmVjb3JkKHJlY29yZCkgOiByZWNvcmQpO1xuICAgICAgICAgICAgICAgIHN5bmNMaXN0ZW5lci5ub3RpZnkoJ2FkZCcsIHJlY29yZCk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlY29yZDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gdXBkYXRlUmVjb3JkKHJlY29yZCkge1xuICAgICAgICAgICAgICAgIHZhciBwcmV2aW91cyA9IGdldFJlY29yZFN0YXRlKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgaWYgKGdldFJldmlzaW9uKHJlY29yZCkgPD0gZ2V0UmV2aXNpb24ocHJldmlvdXMpKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBudWxsO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBsb2dEZWJ1ZygnU3luYyAtPiBVcGRhdGVkIHJlY29yZCAjJyArIEpTT04uc3RyaW5naWZ5KHJlY29yZC5pZCkgKyAnIGZvciBzdWJzY3JpcHRpb24gdG8gJyArIHB1YmxpY2F0aW9uKTsvLyBKU09OLnN0cmluZ2lmeShyZWNvcmQpKTtcbiAgICAgICAgICAgICAgICB1cGRhdGVEYXRhU3RvcmFnZShmb3JtYXRSZWNvcmQgPyBmb3JtYXRSZWNvcmQocmVjb3JkKSA6IHJlY29yZCk7XG4gICAgICAgICAgICAgICAgc3luY0xpc3RlbmVyLm5vdGlmeSgndXBkYXRlJywgcmVjb3JkKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gcmVjb3JkO1xuICAgICAgICAgICAgfVxuXG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIHJlbW92ZVJlY29yZChyZWNvcmQpIHtcbiAgICAgICAgICAgICAgICB2YXIgcHJldmlvdXMgPSBnZXRSZWNvcmRTdGF0ZShyZWNvcmQpO1xuICAgICAgICAgICAgICAgIGlmICghcHJldmlvdXMgfHwgZ2V0UmV2aXNpb24ocmVjb3JkKSA+IGdldFJldmlzaW9uKHByZXZpb3VzKSkge1xuICAgICAgICAgICAgICAgICAgICBsb2dEZWJ1ZygnU3luYyAtPiBSZW1vdmVkICMnICsgSlNPTi5zdHJpbmdpZnkocmVjb3JkLmlkKSArICcgZm9yIHN1YnNjcmlwdGlvbiB0byAnICsgcHVibGljYXRpb24pO1xuICAgICAgICAgICAgICAgICAgICAvLyBXZSBjb3VsZCBoYXZlIGZvciB0aGUgc2FtZSByZWNvcmQgY29uc2VjdXRpdmVseSBmZXRjaGluZyBpbiB0aGlzIG9yZGVyOlxuICAgICAgICAgICAgICAgICAgICAvLyBkZWxldGUgaWQ6NCwgcmV2IDEwLCB0aGVuIGFkZCBpZDo0LCByZXYgOS4uLi4gYnkga2VlcGluZyB0cmFjayBvZiB3aGF0IHdhcyBkZWxldGVkLCB3ZSB3aWxsIG5vdCBhZGQgdGhlIHJlY29yZCBzaW5jZSBpdCB3YXMgZGVsZXRlZCB3aXRoIGEgbW9zdCByZWNlbnQgdGltZXN0YW1wLlxuICAgICAgICAgICAgICAgICAgICByZWNvcmQucmVtb3ZlZCA9IHRydWU7IC8vIFNvIHdlIG9ubHkgZmxhZyBhcyByZW1vdmVkLCBsYXRlciBvbiB0aGUgZ2FyYmFnZSBjb2xsZWN0b3Igd2lsbCBnZXQgcmlkIG9mIGl0LiAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICB1cGRhdGVEYXRhU3RvcmFnZShyZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICAvLyBpZiB0aGVyZSBpcyBubyBwcmV2aW91cyByZWNvcmQgd2UgZG8gbm90IG5lZWQgdG8gcmVtb3ZlZCBhbnkgdGhpbmcgZnJvbSBvdXIgc3RvcmFnZS4gICAgIFxuICAgICAgICAgICAgICAgICAgICBpZiAocHJldmlvdXMpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHN5bmNMaXN0ZW5lci5ub3RpZnkoJ3JlbW92ZScsIHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgICAgICBkaXNwb3NlKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBmdW5jdGlvbiBkaXNwb3NlKHJlY29yZCkge1xuICAgICAgICAgICAgICAgICRzeW5jR2FyYmFnZUNvbGxlY3Rvci5kaXNwb3NlKGZ1bmN0aW9uIGNvbGxlY3QoKSB7XG4gICAgICAgICAgICAgICAgICAgIHZhciBleGlzdGluZ1JlY29yZCA9IGdldFJlY29yZFN0YXRlKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgIGlmIChleGlzdGluZ1JlY29yZCAmJiByZWNvcmQucmV2aXNpb24gPj0gZXhpc3RpbmdSZWNvcmQucmV2aXNpb25cbiAgICAgICAgICAgICAgICAgICAgKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvL2xvZ0RlYnVnKCdDb2xsZWN0IE5vdzonICsgSlNPTi5zdHJpbmdpZnkocmVjb3JkKSk7XG4gICAgICAgICAgICAgICAgICAgICAgICBkZWxldGUgcmVjb3JkU3RhdGVzW2dldElkVmFsdWUocmVjb3JkLmlkKV07XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gaXNFeGlzdGluZ1N0YXRlRm9yKHJlY29yZCkge1xuICAgICAgICAgICAgICAgIHJldHVybiAhIWdldFJlY29yZFN0YXRlKHJlY29yZCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIHNhdmVSZWNvcmRTdGF0ZShyZWNvcmQpIHtcbiAgICAgICAgICAgICAgICByZWNvcmRTdGF0ZXNbZ2V0SWRWYWx1ZShyZWNvcmQuaWQpXSA9IHJlY29yZDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gZ2V0UmVjb3JkU3RhdGUocmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlY29yZFN0YXRlc1tnZXRJZFZhbHVlKHJlY29yZC5pZCldO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiB1cGRhdGVTeW5jZWRPYmplY3QocmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgc2F2ZVJlY29yZFN0YXRlKHJlY29yZCk7XG5cbiAgICAgICAgICAgICAgICBpZiAoIXJlY29yZC5yZW1vdmUpIHtcbiAgICAgICAgICAgICAgICAgICAgJHN5bmNNZXJnZS51cGRhdGUoY2FjaGUsIHJlY29yZCwgc3RyaWN0TW9kZSk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgJHN5bmNNZXJnZS5jbGVhck9iamVjdChjYWNoZSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiB1cGRhdGVTeW5jZWRBcnJheShyZWNvcmQpIHtcbiAgICAgICAgICAgICAgICB2YXIgZXhpc3RpbmcgPSBnZXRSZWNvcmRTdGF0ZShyZWNvcmQpO1xuICAgICAgICAgICAgICAgIGlmICghZXhpc3RpbmcpIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gYWRkIG5ldyBpbnN0YW5jZVxuICAgICAgICAgICAgICAgICAgICBzYXZlUmVjb3JkU3RhdGUocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFyZWNvcmQucmVtb3ZlZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgY2FjaGUucHVzaChyZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgJHN5bmNNZXJnZS51cGRhdGUoZXhpc3RpbmcsIHJlY29yZCwgc3RyaWN0TW9kZSk7XG4gICAgICAgICAgICAgICAgICAgIGlmIChyZWNvcmQucmVtb3ZlZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgY2FjaGUuc3BsaWNlKGNhY2hlLmluZGV4T2YoZXhpc3RpbmcpLCAxKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gZ2V0UmV2aXNpb24ocmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgLy8gd2hhdCByZXNlcnZlZCBmaWVsZCBkbyB3ZSB1c2UgYXMgdGltZXN0YW1wXG4gICAgICAgICAgICAgICAgaWYgKGFuZ3VsYXIuaXNEZWZpbmVkKHJlY29yZC5yZXZpc2lvbikpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHJlY29yZC5yZXZpc2lvbjtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgaWYgKGFuZ3VsYXIuaXNEZWZpbmVkKHJlY29yZC50aW1lc3RhbXApKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiByZWNvcmQudGltZXN0YW1wO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1N5bmMgcmVxdWlyZXMgYSByZXZpc2lvbiBvciB0aW1lc3RhbXAgcHJvcGVydHkgaW4gcmVjZWl2ZWQgJyArIChvYmplY3RDbGFzcyA/ICdvYmplY3QgWycgKyBvYmplY3RDbGFzcy5uYW1lICsgJ10nIDogJ3JlY29yZCcpKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiB0aGlzIG9iamVjdCBcbiAgICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIFN5bmNMaXN0ZW5lcigpIHtcbiAgICAgICAgICAgIHZhciBldmVudHMgPSB7fTtcbiAgICAgICAgICAgIHZhciBjb3VudCA9IDA7XG5cbiAgICAgICAgICAgIHRoaXMubm90aWZ5ID0gbm90aWZ5O1xuICAgICAgICAgICAgdGhpcy5vbiA9IG9uO1xuXG4gICAgICAgICAgICBmdW5jdGlvbiBub3RpZnkoZXZlbnQsIGRhdGExLCBkYXRhMikge1xuICAgICAgICAgICAgICAgIHZhciBsaXN0ZW5lcnMgPSBldmVudHNbZXZlbnRdO1xuICAgICAgICAgICAgICAgIGlmIChsaXN0ZW5lcnMpIHtcbiAgICAgICAgICAgICAgICAgICAgXy5mb3JFYWNoKGxpc3RlbmVycywgZnVuY3Rpb24gKGNhbGxiYWNrLCBpZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgY2FsbGJhY2soZGF0YTEsIGRhdGEyKTtcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqIEByZXR1cm5zIGhhbmRsZXIgdG8gdW5yZWdpc3RlciBsaXN0ZW5lclxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBvbihldmVudCwgY2FsbGJhY2spIHtcbiAgICAgICAgICAgICAgICB2YXIgbGlzdGVuZXJzID0gZXZlbnRzW2V2ZW50XTtcbiAgICAgICAgICAgICAgICBpZiAoIWxpc3RlbmVycykge1xuICAgICAgICAgICAgICAgICAgICBsaXN0ZW5lcnMgPSBldmVudHNbZXZlbnRdID0ge307XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHZhciBpZCA9IGNvdW50Kys7XG4gICAgICAgICAgICAgICAgbGlzdGVuZXJzW2lkKytdID0gY2FsbGJhY2s7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICAgICAgZGVsZXRlIGxpc3RlbmVyc1tpZF07XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfTtcbiAgICBmdW5jdGlvbiBnZXRJZFZhbHVlKGlkKSB7XG4gICAgICAgIGlmICghXy5pc09iamVjdChpZCkpIHtcbiAgICAgICAgICAgIHJldHVybiBpZDtcbiAgICAgICAgfVxuICAgICAgICAvLyBidWlsZCBjb21wb3NpdGUga2V5IHZhbHVlXG4gICAgICAgIHZhciByID0gXy5qb2luKF8ubWFwKGlkLCBmdW5jdGlvbiAodmFsdWUpIHtcbiAgICAgICAgICAgIHJldHVybiB2YWx1ZTtcbiAgICAgICAgfSksICd+Jyk7XG4gICAgICAgIHJldHVybiByO1xuICAgIH1cblxuXG4gICAgZnVuY3Rpb24gbG9nSW5mbyhtc2cpIHtcbiAgICAgICAgaWYgKGRlYnVnKSB7XG4gICAgICAgICAgICBjb25zb2xlLmRlYnVnKCdTWU5DKGluZm8pOiAnICsgbXNnKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGZ1bmN0aW9uIGxvZ0RlYnVnKG1zZykge1xuICAgICAgICBpZiAoZGVidWcgPT0gMikge1xuICAgICAgICAgICAgY29uc29sZS5kZWJ1ZygnU1lOQyhkZWJ1Zyk6ICcgKyBtc2cpO1xuICAgICAgICB9XG5cbiAgICB9XG5cblxuXG59O1xuXG4iXX0=
