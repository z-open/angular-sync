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


        function findObjectReference(value) {
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

            // let's say we sync on person
            // person has parentId
            // but thru dress we replace parentId py parent and store the parent object

            // we do not need to merge parent because it has a revision number
            // dress that happens during setOnReady, will set the parent object based on the parentId




            // create new object containing only the properties of source merge with destination
            var newValue, object = {};
            for (var property in source) {
                var reference = findObjectReference(source[property]);

                //Object.getOwnPropertyDescriptor                
                var d = Object.getOwnPropertyDescriptor(source, property);
                if (d && (d.set || d.get)) {
                    // do nothing, it is computed

                } else if (reference) {
                    // if the object in the source was already processed,
                    // let's use the reference
                    object[property] = reference;//destination[property];

                } else if (_.isArray(source[property])) {

                    // if an array is multiple time references in the source
                    // make sure we will also reference multiple time the same object in the destination
                    if (destination[property]) {
                        processed.push({ value: source[property], newValue: destination[property] });
                        object[property] = updateArray(destination[property], source[property], isStrictMode);
                    } else {
                        processed.push({ value: source[property], newValue: source[property] });
                        object[property] = source[property];
                    }


                } else if (_.isFunction(source[property])) {
                    // Function are not merged. Do nothing.

                } else if (_.isObject(source[property]) && !_.isDate(source[property])) {
                    if (destination[property]) {
                        // the related object exists in the destination,
                        // let's update it.
                        // 
                        // so next time, a source property deals with this object, there will be no need to merge it.
                        processed.push({ value: source[property], newValue: destination[property] });
                        object[property] = updateObject(destination[property], source[property], isStrictMode);
                    } else {
                        processed.push({ value: source[property], newValue: source[property] });
                        object[property] = source[property];
                    }

                } else {
                    // a basic property value is just copied.
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

                var processedReference = findObjectReference(item);
                if (processedReference) {
                    // if an object is already referenced, let's use the same reference;
                    array.push(processedReference);
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
                                var dest = _.find(destination, function (obj) {
                                    return obj.id.toString() === item.id.toString();
                                });

                                // save reference to an object for reuse;                                
                                processed.push({ value: item, newValue: dest });                                

                                array.push(updateObject(dest, item, isStrictMode));
                                
                            } else {
                                if (isStrictMode) {
                                    throw new Error('objects in array must have an id otherwise we can\'t maintain the instance reference. ' + stringify(item));
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

    function stringify(obj) {
        try {
            return JSON.stringify(obj);
        }
        catch (err) {
            return 'Object has cyclic structure.';
        }
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

//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbInN5bmMubW9kdWxlLmpzIiwic2VydmljZXMvc3luYy1nYXJiYWdlLWNvbGxlY3Rvci5zZXJ2aWNlLmpzIiwic2VydmljZXMvc3luYy1tZXJnZS5zZXJ2aWNlLmpzIiwic2VydmljZXMvc3luYy5zZXJ2aWNlLmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiI7OztBQUFBO0FBQ0E7Ozs7OztBQ0RBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTs7Ozs7O0FDekVBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBOzs7Ozs7QUNqTEE7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQTtBQUNBO0FBQ0E7QUFDQSIsImZpbGUiOiJhcHAtaWlmZS5qcyIsInNvdXJjZXNDb250ZW50IjpbImFuZ3VsYXJcbiAgICAubW9kdWxlKCdzeW5jJywgWydzb2NrZXRpby1hdXRoJ10pO1xuIiwiYW5ndWxhclxuICAgIC5tb2R1bGUoJ3N5bmMnKVxuICAgIC5mYWN0b3J5KCckc3luY0dhcmJhZ2VDb2xsZWN0b3InLCBzeW5jR2FyYmFnZUNvbGxlY3Rvcik7XG5cbi8qKlxuICogc2FmZWx5IHJlbW92ZSBkZWxldGVkIHJlY29yZC9vYmplY3QgZnJvbSBtZW1vcnkgYWZ0ZXIgdGhlIHN5bmMgcHJvY2VzcyBkaXNwb3NlZCB0aGVtLlxuICogXG4gKiBUT0RPOiBTZWNvbmRzIHNob3VsZCByZWZsZWN0IHRoZSBtYXggdGltZSAgdGhhdCBzeW5jIGNhY2hlIGlzIHZhbGlkIChuZXR3b3JrIGxvc3Mgd291bGQgZm9yY2UgYSByZXN5bmMpLCB3aGljaCBzaG91bGQgbWF0Y2ggbWF4RGlzY29ubmVjdGlvblRpbWVCZWZvcmVEcm9wcGluZ1N1YnNjcmlwdGlvbiBvbiB0aGUgc2VydmVyIHNpZGUuXG4gKiBcbiAqIE5vdGU6XG4gKiByZW1vdmVkIHJlY29yZCBzaG91bGQgYmUgZGVsZXRlZCBmcm9tIHRoZSBzeW5jIGludGVybmFsIGNhY2hlIGFmdGVyIGEgd2hpbGUgc28gdGhhdCB0aGV5IGRvIG5vdCBzdGF5IGluIHRoZSBtZW1vcnkuIFRoZXkgY2Fubm90IGJlIHJlbW92ZWQgdG9vIGVhcmx5IGFzIGFuIG9sZGVyIHZlcnNpb24vc3RhbXAgb2YgdGhlIHJlY29yZCBjb3VsZCBiZSByZWNlaXZlZCBhZnRlciBpdHMgcmVtb3ZhbC4uLndoaWNoIHdvdWxkIHJlLWFkZCB0byBjYWNoZS4uLmR1ZSBhc3luY2hyb25vdXMgcHJvY2Vzc2luZy4uLlxuICovXG5mdW5jdGlvbiBzeW5jR2FyYmFnZUNvbGxlY3RvcigpIHtcbiAgICB2YXIgaXRlbXMgPSBbXTtcbiAgICB2YXIgc2Vjb25kcyA9IDI7XG4gICAgdmFyIHNjaGVkdWxlZCA9IGZhbHNlO1xuXG4gICAgdmFyIHNlcnZpY2UgPSB7XG4gICAgICAgIHNldFNlY29uZHM6IHNldFNlY29uZHMsXG4gICAgICAgIGdldFNlY29uZHM6IGdldFNlY29uZHMsXG4gICAgICAgIGRpc3Bvc2U6IGRpc3Bvc2UsXG4gICAgICAgIHNjaGVkdWxlOiBzY2hlZHVsZSxcbiAgICAgICAgcnVuOiBydW4sXG4gICAgICAgIGdldEl0ZW1Db3VudDogZ2V0SXRlbUNvdW50XG4gICAgfTtcblxuICAgIHJldHVybiBzZXJ2aWNlO1xuXG4gICAgLy8vLy8vLy8vL1xuXG4gICAgZnVuY3Rpb24gc2V0U2Vjb25kcyh2YWx1ZSkge1xuICAgICAgICBzZWNvbmRzID0gdmFsdWU7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gZ2V0U2Vjb25kcygpIHtcbiAgICAgICAgcmV0dXJuIHNlY29uZHM7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gZ2V0SXRlbUNvdW50KCkge1xuICAgICAgICByZXR1cm4gaXRlbXMubGVuZ3RoO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIGRpc3Bvc2UoY29sbGVjdCkge1xuICAgICAgICBpdGVtcy5wdXNoKHtcbiAgICAgICAgICAgIHRpbWVzdGFtcDogRGF0ZS5ub3coKSxcbiAgICAgICAgICAgIGNvbGxlY3Q6IGNvbGxlY3RcbiAgICAgICAgfSk7XG4gICAgICAgIGlmICghc2NoZWR1bGVkKSB7XG4gICAgICAgICAgICBzZXJ2aWNlLnNjaGVkdWxlKCk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBmdW5jdGlvbiBzY2hlZHVsZSgpIHtcbiAgICAgICAgaWYgKCFzZWNvbmRzKSB7XG4gICAgICAgICAgICBzZXJ2aWNlLnJ1bigpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIHNjaGVkdWxlZCA9IHRydWU7XG4gICAgICAgIHNldFRpbWVvdXQoZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgc2VydmljZS5ydW4oKTtcbiAgICAgICAgICAgIGlmIChpdGVtcy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICAgICAgc2NoZWR1bGUoKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgc2NoZWR1bGVkID0gZmFsc2U7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0sIHNlY29uZHMgKiAxMDAwKTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBydW4oKSB7XG4gICAgICAgIHZhciB0aW1lb3V0ID0gRGF0ZS5ub3coKSAtIHNlY29uZHMgKiAxMDAwO1xuICAgICAgICB3aGlsZSAoaXRlbXMubGVuZ3RoID4gMCAmJiBpdGVtc1swXS50aW1lc3RhbXAgPD0gdGltZW91dCkge1xuICAgICAgICAgICAgaXRlbXMuc2hpZnQoKS5jb2xsZWN0KCk7XG4gICAgICAgIH1cbiAgICB9XG59XG5cblxuIiwiXG5hbmd1bGFyXG4gICAgLm1vZHVsZSgnc3luYycpXG4gICAgLmZhY3RvcnkoJyRzeW5jTWVyZ2UnLCBzeW5jTWVyZ2UpO1xuXG5mdW5jdGlvbiBzeW5jTWVyZ2UoKSB7XG5cbiAgICByZXR1cm4ge1xuICAgICAgICB1cGRhdGU6IHVwZGF0ZSxcbiAgICAgICAgY2xlYXJPYmplY3Q6IGNsZWFyT2JqZWN0XG4gICAgfVxuXG5cbiAgICAvKipcbiAgICAgKiBUaGlzIGZ1bmN0aW9uIHVwZGF0ZXMgYW4gb2JqZWN0IHdpdGggdGhlIGNvbnRlbnQgb2YgYW5vdGhlci5cbiAgICAgKiBUaGUgaW5uZXIgb2JqZWN0cyBhbmQgb2JqZWN0cyBpbiBhcnJheSB3aWxsIGFsc28gYmUgdXBkYXRlZC5cbiAgICAgKiBSZWZlcmVuY2VzIHRvIHRoZSBvcmlnaW5hbCBvYmplY3RzIGFyZSBtYWludGFpbmVkIGluIHRoZSBkZXN0aW5hdGlvbiBvYmplY3Qgc28gT25seSBjb250ZW50IGlzIHVwZGF0ZWQuXG4gICAgICpcbiAgICAgKiBUaGUgcHJvcGVydGllcyBpbiB0aGUgc291cmNlIG9iamVjdCB0aGF0IGFyZSBub3QgaW4gdGhlIGRlc3RpbmF0aW9uIHdpbGwgYmUgcmVtb3ZlZCBmcm9tIHRoZSBkZXN0aW5hdGlvbiBvYmplY3QuXG4gICAgICpcbiAgICAgKiBcbiAgICAgKlxuICAgICAqQHBhcmFtIDxvYmplY3Q+IGRlc3RpbmF0aW9uICBvYmplY3QgdG8gdXBkYXRlXG4gICAgICpAcGFyYW0gPG9iamVjdD4gc291cmNlICBvYmplY3QgdG8gdXBkYXRlIGZyb21cbiAgICAgKkBwYXJhbSA8Ym9vbGVhbj4gaXNTdHJpY3RNb2RlIGRlZmF1bHQgZmFsc2UsIGlmIHRydWUgd291bGQgZ2VuZXJhdGUgYW4gZXJyb3IgaWYgaW5uZXIgb2JqZWN0cyBpbiBhcnJheSBkbyBub3QgaGF2ZSBpZCBmaWVsZFxuICAgICAqL1xuXG4gICAgZnVuY3Rpb24gdXBkYXRlKGRlc3RpbmF0aW9uLCBzb3VyY2UsIGlzU3RyaWN0TW9kZSkge1xuXG4gICAgICAgIHZhciBwcm9jZXNzZWQgPSBbXTtcblxuICAgICAgICByZXR1cm4gdXBkYXRlT2JqZWN0KGRlc3RpbmF0aW9uLCBzb3VyY2UsIGlzU3RyaWN0TW9kZSk7XG5cblxuICAgICAgICBmdW5jdGlvbiBmaW5kT2JqZWN0UmVmZXJlbmNlKHZhbHVlKSB7XG4gICAgICAgICAgICBpZiAoIV8uaXNBcnJheSh2YWx1ZSkgJiYgIV8uaXNPYmplY3QodmFsdWUpICYmICFfLmlzRGF0ZSh2YWx1ZSkgJiYgIV8uaXNGdW5jdGlvbih2YWx1ZSkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHZhciBmb3VuZCA9IF8uZmluZChwcm9jZXNzZWQsIGZ1bmN0aW9uIChwKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHZhbHVlID09PSBwLnZhbHVlO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICByZXR1cm4gZm91bmQgPyBmb3VuZC5uZXdWYWx1ZSA6IG51bGw7XG4gICAgICAgIH1cblxuICAgICAgICBcblxuICAgICAgICBmdW5jdGlvbiB1cGRhdGVPYmplY3QoZGVzdGluYXRpb24sIHNvdXJjZSwgaXNTdHJpY3RNb2RlKSB7XG4gICAgICAgICAgICBpZiAoIWRlc3RpbmF0aW9uKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHNvdXJjZTsvLyBfLmFzc2lnbih7fSwgc291cmNlKTs7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIGxldCdzIHNheSB3ZSBzeW5jIG9uIHBlcnNvblxuICAgICAgICAgICAgLy8gcGVyc29uIGhhcyBwYXJlbnRJZFxuICAgICAgICAgICAgLy8gYnV0IHRocnUgZHJlc3Mgd2UgcmVwbGFjZSBwYXJlbnRJZCBweSBwYXJlbnQgYW5kIHN0b3JlIHRoZSBwYXJlbnQgb2JqZWN0XG5cbiAgICAgICAgICAgIC8vIHdlIGRvIG5vdCBuZWVkIHRvIG1lcmdlIHBhcmVudCBiZWNhdXNlIGl0IGhhcyBhIHJldmlzaW9uIG51bWJlclxuICAgICAgICAgICAgLy8gZHJlc3MgdGhhdCBoYXBwZW5zIGR1cmluZyBzZXRPblJlYWR5LCB3aWxsIHNldCB0aGUgcGFyZW50IG9iamVjdCBiYXNlZCBvbiB0aGUgcGFyZW50SWRcblxuXG5cblxuICAgICAgICAgICAgLy8gY3JlYXRlIG5ldyBvYmplY3QgY29udGFpbmluZyBvbmx5IHRoZSBwcm9wZXJ0aWVzIG9mIHNvdXJjZSBtZXJnZSB3aXRoIGRlc3RpbmF0aW9uXG4gICAgICAgICAgICB2YXIgbmV3VmFsdWUsIG9iamVjdCA9IHt9O1xuICAgICAgICAgICAgZm9yICh2YXIgcHJvcGVydHkgaW4gc291cmNlKSB7XG4gICAgICAgICAgICAgICAgdmFyIHJlZmVyZW5jZSA9IGZpbmRPYmplY3RSZWZlcmVuY2Uoc291cmNlW3Byb3BlcnR5XSk7XG5cbiAgICAgICAgICAgICAgICAvL09iamVjdC5nZXRPd25Qcm9wZXJ0eURlc2NyaXB0b3IgICAgICAgICAgICAgICAgXG4gICAgICAgICAgICAgICAgdmFyIGQgPSBPYmplY3QuZ2V0T3duUHJvcGVydHlEZXNjcmlwdG9yKHNvdXJjZSwgcHJvcGVydHkpO1xuICAgICAgICAgICAgICAgIGlmIChkICYmIChkLnNldCB8fCBkLmdldCkpIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gZG8gbm90aGluZywgaXQgaXMgY29tcHV0ZWRcblxuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAocmVmZXJlbmNlKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIGlmIHRoZSBvYmplY3QgaW4gdGhlIHNvdXJjZSB3YXMgYWxyZWFkeSBwcm9jZXNzZWQsXG4gICAgICAgICAgICAgICAgICAgIC8vIGxldCdzIHVzZSB0aGUgcmVmZXJlbmNlXG4gICAgICAgICAgICAgICAgICAgIG9iamVjdFtwcm9wZXJ0eV0gPSByZWZlcmVuY2U7Ly9kZXN0aW5hdGlvbltwcm9wZXJ0eV07XG5cbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKF8uaXNBcnJheShzb3VyY2VbcHJvcGVydHldKSkge1xuXG4gICAgICAgICAgICAgICAgICAgIC8vIGlmIGFuIGFycmF5IGlzIG11bHRpcGxlIHRpbWUgcmVmZXJlbmNlcyBpbiB0aGUgc291cmNlXG4gICAgICAgICAgICAgICAgICAgIC8vIG1ha2Ugc3VyZSB3ZSB3aWxsIGFsc28gcmVmZXJlbmNlIG11bHRpcGxlIHRpbWUgdGhlIHNhbWUgb2JqZWN0IGluIHRoZSBkZXN0aW5hdGlvblxuICAgICAgICAgICAgICAgICAgICBpZiAoZGVzdGluYXRpb25bcHJvcGVydHldKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBwcm9jZXNzZWQucHVzaCh7IHZhbHVlOiBzb3VyY2VbcHJvcGVydHldLCBuZXdWYWx1ZTogZGVzdGluYXRpb25bcHJvcGVydHldIH0pO1xuICAgICAgICAgICAgICAgICAgICAgICAgb2JqZWN0W3Byb3BlcnR5XSA9IHVwZGF0ZUFycmF5KGRlc3RpbmF0aW9uW3Byb3BlcnR5XSwgc291cmNlW3Byb3BlcnR5XSwgaXNTdHJpY3RNb2RlKTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHByb2Nlc3NlZC5wdXNoKHsgdmFsdWU6IHNvdXJjZVtwcm9wZXJ0eV0sIG5ld1ZhbHVlOiBzb3VyY2VbcHJvcGVydHldIH0pO1xuICAgICAgICAgICAgICAgICAgICAgICAgb2JqZWN0W3Byb3BlcnR5XSA9IHNvdXJjZVtwcm9wZXJ0eV07XG4gICAgICAgICAgICAgICAgICAgIH1cblxuXG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChfLmlzRnVuY3Rpb24oc291cmNlW3Byb3BlcnR5XSkpIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gRnVuY3Rpb24gYXJlIG5vdCBtZXJnZWQuIERvIG5vdGhpbmcuXG5cbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKF8uaXNPYmplY3Qoc291cmNlW3Byb3BlcnR5XSkgJiYgIV8uaXNEYXRlKHNvdXJjZVtwcm9wZXJ0eV0pKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmIChkZXN0aW5hdGlvbltwcm9wZXJ0eV0pIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIHRoZSByZWxhdGVkIG9iamVjdCBleGlzdHMgaW4gdGhlIGRlc3RpbmF0aW9uLFxuICAgICAgICAgICAgICAgICAgICAgICAgLy8gbGV0J3MgdXBkYXRlIGl0LlxuICAgICAgICAgICAgICAgICAgICAgICAgLy8gXG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBzbyBuZXh0IHRpbWUsIGEgc291cmNlIHByb3BlcnR5IGRlYWxzIHdpdGggdGhpcyBvYmplY3QsIHRoZXJlIHdpbGwgYmUgbm8gbmVlZCB0byBtZXJnZSBpdC5cbiAgICAgICAgICAgICAgICAgICAgICAgIHByb2Nlc3NlZC5wdXNoKHsgdmFsdWU6IHNvdXJjZVtwcm9wZXJ0eV0sIG5ld1ZhbHVlOiBkZXN0aW5hdGlvbltwcm9wZXJ0eV0gfSk7XG4gICAgICAgICAgICAgICAgICAgICAgICBvYmplY3RbcHJvcGVydHldID0gdXBkYXRlT2JqZWN0KGRlc3RpbmF0aW9uW3Byb3BlcnR5XSwgc291cmNlW3Byb3BlcnR5XSwgaXNTdHJpY3RNb2RlKTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIHByb2Nlc3NlZC5wdXNoKHsgdmFsdWU6IHNvdXJjZVtwcm9wZXJ0eV0sIG5ld1ZhbHVlOiBzb3VyY2VbcHJvcGVydHldIH0pO1xuICAgICAgICAgICAgICAgICAgICAgICAgb2JqZWN0W3Byb3BlcnR5XSA9IHNvdXJjZVtwcm9wZXJ0eV07XG4gICAgICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIGEgYmFzaWMgcHJvcGVydHkgdmFsdWUgaXMganVzdCBjb3BpZWQuXG4gICAgICAgICAgICAgICAgICAgIG9iamVjdFtwcm9wZXJ0eV0gPSBzb3VyY2VbcHJvcGVydHldO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgY2xlYXJPYmplY3QoZGVzdGluYXRpb24pO1xuICAgICAgICAgICAgXy5hc3NpZ24oZGVzdGluYXRpb24sIG9iamVjdCk7XG5cbiAgICAgICAgICAgIHJldHVybiBkZXN0aW5hdGlvbjtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIHVwZGF0ZUFycmF5KGRlc3RpbmF0aW9uLCBzb3VyY2UsIGlzU3RyaWN0TW9kZSkge1xuICAgICAgICAgICAgaWYgKCFkZXN0aW5hdGlvbikge1xuICAgICAgICAgICAgICAgIHJldHVybiBzb3VyY2U7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICB2YXIgYXJyYXkgPSBbXTtcbiAgICAgICAgICAgIHNvdXJjZS5mb3JFYWNoKGZ1bmN0aW9uIChpdGVtKSB7XG5cbiAgICAgICAgICAgICAgICB2YXIgcHJvY2Vzc2VkUmVmZXJlbmNlID0gZmluZE9iamVjdFJlZmVyZW5jZShpdGVtKTtcbiAgICAgICAgICAgICAgICBpZiAocHJvY2Vzc2VkUmVmZXJlbmNlKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIGlmIGFuIG9iamVjdCBpcyBhbHJlYWR5IHJlZmVyZW5jZWQsIGxldCdzIHVzZSB0aGUgc2FtZSByZWZlcmVuY2U7XG4gICAgICAgICAgICAgICAgICAgIGFycmF5LnB1c2gocHJvY2Vzc2VkUmVmZXJlbmNlKTtcbiAgICAgICAgICAgICAgICB9IGVsc2VcblxuICAgICAgICAgICAgICAgICAgICAvLyBkb2VzIG5vdCB0cnkgdG8gbWFpbnRhaW4gb2JqZWN0IHJlZmVyZW5jZXMgaW4gYXJyYXlzXG4gICAgICAgICAgICAgICAgICAgIC8vIHN1cGVyIGxvb3NlIG1vZGUuXG4gICAgICAgICAgICAgICAgICAgIGlmIChpc1N0cmljdE1vZGUgPT09ICdOT05FJykge1xuICAgICAgICAgICAgICAgICAgICAgICAgYXJyYXkucHVzaChpdGVtKTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIG9iamVjdCBpbiBhcnJheSBtdXN0IGhhdmUgYW4gaWQgb3RoZXJ3aXNlIHdlIGNhbid0IG1haW50YWluIHRoZSBpbnN0YW5jZSByZWZlcmVuY2VcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghXy5pc0FycmF5KGl0ZW0pICYmIF8uaXNPYmplY3QoaXRlbSkpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAvLyBsZXQgdHJ5IHRvIGZpbmQgdGhlIGluc3RhbmNlXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKGFuZ3VsYXIuaXNEZWZpbmVkKGl0ZW0uaWQpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIHZhciBkZXN0ID0gXy5maW5kKGRlc3RpbmF0aW9uLCBmdW5jdGlvbiAob2JqKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICByZXR1cm4gb2JqLmlkLnRvU3RyaW5nKCkgPT09IGl0ZW0uaWQudG9TdHJpbmcoKTtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgfSk7XG5cbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgLy8gc2F2ZSByZWZlcmVuY2UgdG8gYW4gb2JqZWN0IGZvciByZXVzZTsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBwcm9jZXNzZWQucHVzaCh7IHZhbHVlOiBpdGVtLCBuZXdWYWx1ZTogZGVzdCB9KTsgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIFxuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFycmF5LnB1c2godXBkYXRlT2JqZWN0KGRlc3QsIGl0ZW0sIGlzU3RyaWN0TW9kZSkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBpZiAoaXNTdHJpY3RNb2RlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ29iamVjdHMgaW4gYXJyYXkgbXVzdCBoYXZlIGFuIGlkIG90aGVyd2lzZSB3ZSBjYW5cXCd0IG1haW50YWluIHRoZSBpbnN0YW5jZSByZWZlcmVuY2UuICcgKyBzdHJpbmdpZnkoaXRlbSkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgIGFycmF5LnB1c2goaXRlbSk7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBhcnJheS5wdXNoKGl0ZW0pO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcblxuICAgICAgICAgICAgZGVzdGluYXRpb24ubGVuZ3RoID0gMDtcbiAgICAgICAgICAgIEFycmF5LnByb3RvdHlwZS5wdXNoLmFwcGx5KGRlc3RpbmF0aW9uLCBhcnJheSk7XG4gICAgICAgICAgICAvL2FuZ3VsYXIuY29weShkZXN0aW5hdGlvbiwgYXJyYXkpO1xuICAgICAgICAgICAgcmV0dXJuIGRlc3RpbmF0aW9uO1xuICAgICAgICB9XG4gICAgfVxuICAgIGZ1bmN0aW9uIGNsZWFyT2JqZWN0KG9iamVjdCkge1xuICAgICAgICBPYmplY3Qua2V5cyhvYmplY3QpLmZvckVhY2goZnVuY3Rpb24gKGtleSkgeyBkZWxldGUgb2JqZWN0W2tleV07IH0pO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIHN0cmluZ2lmeShvYmopIHtcbiAgICAgICAgdHJ5IHtcbiAgICAgICAgICAgIHJldHVybiBKU09OLnN0cmluZ2lmeShvYmopO1xuICAgICAgICB9XG4gICAgICAgIGNhdGNoIChlcnIpIHtcbiAgICAgICAgICAgIHJldHVybiAnT2JqZWN0IGhhcyBjeWNsaWMgc3RydWN0dXJlLic7XG4gICAgICAgIH1cbiAgICB9XG59O1xuXG4iLCJcbi8qKlxuICogXG4gKiBTZXJ2aWNlIHRoYXQgYWxsb3dzIGFuIGFycmF5IG9mIGRhdGEgcmVtYWluIGluIHN5bmMgd2l0aCBiYWNrZW5kLlxuICogXG4gKiBcbiAqIGV4OlxuICogd2hlbiB0aGVyZSBpcyBhIG5vdGlmaWNhdGlvbiwgbm90aWNhdGlvblNlcnZpY2Ugbm90aWZpZXMgdGhhdCB0aGVyZSBpcyBzb21ldGhpbmcgbmV3Li4udGhlbiB0aGUgZGF0YXNldCBnZXQgdGhlIGRhdGEgYW5kIG5vdGlmaWVzIGFsbCBpdHMgY2FsbGJhY2suXG4gKiBcbiAqIE5PVEU6IFxuICogIFxuICogXG4gKiBQcmUtUmVxdWlzdGU6XG4gKiAtLS0tLS0tLS0tLS0tXG4gKiBTeW5jIHJlcXVpcmVzIG9iamVjdHMgaGF2ZSBCT1RIIGlkIGFuZCByZXZpc2lvbiBmaWVsZHMvcHJvcGVydGllcy5cbiAqIFxuICogV2hlbiB0aGUgYmFja2VuZCB3cml0ZXMgYW55IGRhdGEgdG8gdGhlIGRiIHRoYXQgYXJlIHN1cHBvc2VkIHRvIGJlIHN5bmNyb25pemVkOlxuICogSXQgbXVzdCBtYWtlIHN1cmUgZWFjaCBhZGQsIHVwZGF0ZSwgcmVtb3ZhbCBvZiByZWNvcmQgaXMgdGltZXN0YW1wZWQuXG4gKiBJdCBtdXN0IG5vdGlmeSB0aGUgZGF0YXN0cmVhbSAod2l0aCBub3RpZnlDaGFuZ2Ugb3Igbm90aWZ5UmVtb3ZhbCkgd2l0aCBzb21lIHBhcmFtcyBzbyB0aGF0IGJhY2tlbmQga25vd3MgdGhhdCBpdCBoYXMgdG8gcHVzaCBiYWNrIHRoZSBkYXRhIGJhY2sgdG8gdGhlIHN1YnNjcmliZXJzIChleDogdGhlIHRhc2tDcmVhdGlvbiB3b3VsZCBub3RpZnkgd2l0aCBpdHMgcGxhbklkKVxuKiBcbiAqIFxuICovXG5hbmd1bGFyXG4gICAgLm1vZHVsZSgnc3luYycpXG4gICAgLnByb3ZpZGVyKCckc3luYycsIHN5bmNQcm92aWRlcik7XG5cbmZ1bmN0aW9uIHN5bmNQcm92aWRlcigpIHtcblxuICAgIHZhciBkZWJ1ZztcblxuICAgIHRoaXMuc2V0RGVidWcgPSBmdW5jdGlvbiAodmFsdWUpIHtcbiAgICAgICAgZGVidWcgPSB2YWx1ZTtcbiAgICB9O1xuXG4gICAgdGhpcy4kZ2V0ID0gZnVuY3Rpb24gc3luYygkcm9vdFNjb3BlLCAkcSwgJHNvY2tldGlvLCAkc3luY0dhcmJhZ2VDb2xsZWN0b3IsICRzeW5jTWVyZ2UpIHtcblxuICAgICAgICB2YXIgcHVibGljYXRpb25MaXN0ZW5lcnMgPSB7fSxcbiAgICAgICAgICAgIHB1YmxpY2F0aW9uTGlzdGVuZXJDb3VudCA9IDA7XG4gICAgICAgIHZhciBHUkFDRV9QRVJJT0RfSU5fU0VDT05EUyA9IDg7XG4gICAgICAgIHZhciBTWU5DX1ZFUlNJT04gPSAnMS4yJztcblxuXG4gICAgICAgIGxpc3RlblRvU3luY05vdGlmaWNhdGlvbigpO1xuXG4gICAgICAgIHZhciBzZXJ2aWNlID0ge1xuICAgICAgICAgICAgc3Vic2NyaWJlOiBzdWJzY3JpYmUsXG4gICAgICAgICAgICByZXNvbHZlU3Vic2NyaXB0aW9uOiByZXNvbHZlU3Vic2NyaXB0aW9uLFxuICAgICAgICAgICAgZ2V0R3JhY2VQZXJpb2Q6IGdldEdyYWNlUGVyaW9kLFxuICAgICAgICAgICAgZ2V0SWRWYWx1ZTogZ2V0SWRWYWx1ZVxuICAgICAgICB9O1xuXG4gICAgICAgIHJldHVybiBzZXJ2aWNlO1xuXG4gICAgICAgIC8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vXG4gICAgICAgIC8qKlxuICAgICAgICAgKiBzdWJzY3JpYmUgdG8gcHVibGljYXRpb24gYW5kIHJldHVybnMgdGhlIHN1YnNjcmlwdGlvbiB3aGVuIGRhdGEgaXMgYXZhaWxhYmxlLiBcbiAgICAgICAgICogQHBhcmFtIHB1YmxpY2F0aW9uIG5hbWUuIG9uIHRoZSBzZXJ2ZXIgc2lkZSwgYSBwdWJsaWNhdGlvbiBzaGFsbCBleGlzdC4gZXg6IG1hZ2F6aW5lcy5zeW5jXG4gICAgICAgICAqIEBwYXJhbSBwYXJhbXMgICB0aGUgcGFyYW1zIG9iamVjdCBwYXNzZWQgdG8gdGhlIHN1YnNjcmlwdGlvbiwgZXg6IHttYWdhemluZUlkOidlbnRyZXByZW5ldXInfSlcbiAgICAgICAgICogQHBhcmFtIG9iamVjdENsYXNzIGFuIGluc3RhbmNlIG9mIHRoaXMgY2xhc3Mgd2lsbCBiZSBjcmVhdGVkIGZvciBlYWNoIHJlY29yZCByZWNlaXZlZC5cbiAgICAgICAgICogcmV0dXJucyBhIHByb21pc2UgcmV0dXJuaW5nIHRoZSBzdWJzY3JpcHRpb24gd2hlbiB0aGUgZGF0YSBpcyBzeW5jZWRcbiAgICAgICAgICogb3IgcmVqZWN0cyBpZiB0aGUgaW5pdGlhbCBzeW5jIGZhaWxzIHRvIGNvbXBsZXRlIGluIGEgbGltaXRlZCBhbW91bnQgb2YgdGltZS4gXG4gICAgICAgICAqIFxuICAgICAgICAgKiB0byBnZXQgdGhlIGRhdGEgZnJvbSB0aGUgZGF0YVNldCwganVzdCBkYXRhU2V0LmdldERhdGEoKVxuICAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gcmVzb2x2ZVN1YnNjcmlwdGlvbihwdWJsaWNhdGlvbk5hbWUsIHBhcmFtcywgb2JqZWN0Q2xhc3MpIHtcbiAgICAgICAgICAgIHZhciBkZWZlcnJlZCA9ICRxLmRlZmVyKCk7XG4gICAgICAgICAgICB2YXIgc0RzID0gc3Vic2NyaWJlKHB1YmxpY2F0aW9uTmFtZSkuc2V0T2JqZWN0Q2xhc3Mob2JqZWN0Q2xhc3MpO1xuXG4gICAgICAgICAgICAvLyBnaXZlIGEgbGl0dGxlIHRpbWUgZm9yIHN1YnNjcmlwdGlvbiB0byBmZXRjaCB0aGUgZGF0YS4uLm90aGVyd2lzZSBnaXZlIHVwIHNvIHRoYXQgd2UgZG9uJ3QgZ2V0IHN0dWNrIGluIGEgcmVzb2x2ZSB3YWl0aW5nIGZvcmV2ZXIuXG4gICAgICAgICAgICB2YXIgZ3JhY2VQZXJpb2QgPSBzZXRUaW1lb3V0KGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICBpZiAoIXNEcy5yZWFkeSkge1xuICAgICAgICAgICAgICAgICAgICBzRHMuZGVzdHJveSgpO1xuICAgICAgICAgICAgICAgICAgICBsb2dJbmZvKCdBdHRlbXB0IHRvIHN1YnNjcmliZSB0byBwdWJsaWNhdGlvbiAnICsgcHVibGljYXRpb25OYW1lICsgJyBmYWlsZWQnKTtcbiAgICAgICAgICAgICAgICAgICAgZGVmZXJyZWQucmVqZWN0KCdTWU5DX1RJTUVPVVQnKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9LCBHUkFDRV9QRVJJT0RfSU5fU0VDT05EUyAqIDEwMDApO1xuXG4gICAgICAgICAgICBzRHMuc2V0UGFyYW1ldGVycyhwYXJhbXMpXG4gICAgICAgICAgICAgICAgLndhaXRGb3JEYXRhUmVhZHkoKVxuICAgICAgICAgICAgICAgIC50aGVuKGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICAgICAgY2xlYXJUaW1lb3V0KGdyYWNlUGVyaW9kKTtcbiAgICAgICAgICAgICAgICAgICAgZGVmZXJyZWQucmVzb2x2ZShzRHMpO1xuICAgICAgICAgICAgICAgIH0pLmNhdGNoKGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICAgICAgY2xlYXJUaW1lb3V0KGdyYWNlUGVyaW9kKTtcbiAgICAgICAgICAgICAgICAgICAgc0RzLmRlc3Ryb3koKTtcbiAgICAgICAgICAgICAgICAgICAgZGVmZXJyZWQucmVqZWN0KCdGYWlsZWQgdG8gc3Vic2NyaWJlIHRvIHB1YmxpY2F0aW9uICcgKyBwdWJsaWNhdGlvbk5hbWUgKyAnIGZhaWxlZCcpO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgcmV0dXJuIGRlZmVycmVkLnByb21pc2U7XG4gICAgICAgIH1cblxuICAgICAgICAvKipcbiAgICAgICAgICogXG4gICAgICAgICAqIGZvciB0ZXN0IHB1cnBvc2VzLCByZXR1cm5zIHRoZSB0aW1lIHJlc29sdmVTdWJzY3JpcHRpb24gYmVmb3JlIGl0IHRpbWVzIG91dC5cbiAgICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIGdldEdyYWNlUGVyaW9kKCkge1xuICAgICAgICAgICAgcmV0dXJuIEdSQUNFX1BFUklPRF9JTl9TRUNPTkRTO1xuICAgICAgICB9XG4gICAgICAgIC8qKlxuICAgICAgICAgKiBzdWJzY3JpYmUgdG8gcHVibGljYXRpb24uIEl0IHdpbGwgbm90IHN5bmMgdW50aWwgeW91IHNldCB0aGUgcGFyYW1zLlxuICAgICAgICAgKiBcbiAgICAgICAgICogQHBhcmFtIHB1YmxpY2F0aW9uIG5hbWUuIG9uIHRoZSBzZXJ2ZXIgc2lkZSwgYSBwdWJsaWNhdGlvbiBzaGFsbCBleGlzdC4gZXg6IG1hZ2F6aW5lcy5zeW5jXG4gICAgICAgICAqIEBwYXJhbSBwYXJhbXMgICB0aGUgcGFyYW1zIG9iamVjdCBwYXNzZWQgdG8gdGhlIHN1YnNjcmlwdGlvbiwgZXg6IHttYWdhemluZUlkOidlbnRyZXByZW5ldXInfSlcbiAgICAgICAgICogcmV0dXJucyBzdWJzY3JpcHRpb25cbiAgICAgICAgICogXG4gICAgICAgICAqL1xuICAgICAgICBmdW5jdGlvbiBzdWJzY3JpYmUocHVibGljYXRpb25OYW1lLCBzY29wZSkge1xuICAgICAgICAgICAgcmV0dXJuIG5ldyBTdWJzY3JpcHRpb24ocHVibGljYXRpb25OYW1lLCBzY29wZSk7XG4gICAgICAgIH1cblxuXG5cbiAgICAgICAgLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy9cbiAgICAgICAgLy8gSEVMUEVSU1xuXG4gICAgICAgIC8vIGV2ZXJ5IHN5bmMgbm90aWZpY2F0aW9uIGNvbWVzIHRocnUgdGhlIHNhbWUgZXZlbnQgdGhlbiBpdCBpcyBkaXNwYXRjaGVzIHRvIHRoZSB0YXJnZXRlZCBzdWJzY3JpcHRpb25zLlxuICAgICAgICBmdW5jdGlvbiBsaXN0ZW5Ub1N5bmNOb3RpZmljYXRpb24oKSB7XG4gICAgICAgICAgICAkc29ja2V0aW8ub24oJ1NZTkNfTk9XJywgZnVuY3Rpb24gKHN1Yk5vdGlmaWNhdGlvbiwgZm4pIHtcbiAgICAgICAgICAgICAgICBsb2dJbmZvKCdTeW5jaW5nIHdpdGggc3Vic2NyaXB0aW9uIFtuYW1lOicgKyBzdWJOb3RpZmljYXRpb24ubmFtZSArICcsIGlkOicgKyBzdWJOb3RpZmljYXRpb24uc3Vic2NyaXB0aW9uSWQgKyAnICwgcGFyYW1zOicgKyBKU09OLnN0cmluZ2lmeShzdWJOb3RpZmljYXRpb24ucGFyYW1zKSArICddLiBSZWNvcmRzOicgKyBzdWJOb3RpZmljYXRpb24ucmVjb3Jkcy5sZW5ndGggKyAnWycgKyAoc3ViTm90aWZpY2F0aW9uLmRpZmYgPyAnRGlmZicgOiAnQWxsJykgKyAnXScpO1xuICAgICAgICAgICAgICAgIHZhciBsaXN0ZW5lcnMgPSBwdWJsaWNhdGlvbkxpc3RlbmVyc1tzdWJOb3RpZmljYXRpb24ubmFtZV07XG4gICAgICAgICAgICAgICAgaWYgKGxpc3RlbmVycykge1xuICAgICAgICAgICAgICAgICAgICBmb3IgKHZhciBsaXN0ZW5lciBpbiBsaXN0ZW5lcnMpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxpc3RlbmVyc1tsaXN0ZW5lcl0oc3ViTm90aWZpY2F0aW9uKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBmbignU1lOQ0VEJyk7IC8vIGxldCBrbm93IHRoZSBiYWNrZW5kIHRoZSBjbGllbnQgd2FzIGFibGUgdG8gc3luYy5cbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9O1xuXG5cbiAgICAgICAgLy8gdGhpcyBhbGxvd3MgYSBkYXRhc2V0IHRvIGxpc3RlbiB0byBhbnkgU1lOQ19OT1cgZXZlbnQuLmFuZCBpZiB0aGUgbm90aWZpY2F0aW9uIGlzIGFib3V0IGl0cyBkYXRhLlxuICAgICAgICBmdW5jdGlvbiBhZGRQdWJsaWNhdGlvbkxpc3RlbmVyKHN0cmVhbU5hbWUsIGNhbGxiYWNrKSB7XG4gICAgICAgICAgICB2YXIgdWlkID0gcHVibGljYXRpb25MaXN0ZW5lckNvdW50Kys7XG4gICAgICAgICAgICB2YXIgbGlzdGVuZXJzID0gcHVibGljYXRpb25MaXN0ZW5lcnNbc3RyZWFtTmFtZV07XG4gICAgICAgICAgICBpZiAoIWxpc3RlbmVycykge1xuICAgICAgICAgICAgICAgIHB1YmxpY2F0aW9uTGlzdGVuZXJzW3N0cmVhbU5hbWVdID0gbGlzdGVuZXJzID0ge307XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBsaXN0ZW5lcnNbdWlkXSA9IGNhbGxiYWNrO1xuXG4gICAgICAgICAgICByZXR1cm4gZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgIGRlbGV0ZSBsaXN0ZW5lcnNbdWlkXTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAgICAgLy8gU3Vic2NyaXB0aW9uIG9iamVjdFxuICAgICAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAgICAgLyoqXG4gICAgICAgICAqIGEgc3Vic2NyaXB0aW9uIHN5bmNocm9uaXplcyB3aXRoIHRoZSBiYWNrZW5kIGZvciBhbnkgYmFja2VuZCBkYXRhIGNoYW5nZSBhbmQgbWFrZXMgdGhhdCBkYXRhIGF2YWlsYWJsZSB0byBhIGNvbnRyb2xsZXIuXG4gICAgICAgICAqIFxuICAgICAgICAgKiAgV2hlbiBjbGllbnQgc3Vic2NyaWJlcyB0byBhbiBzeW5jcm9uaXplZCBhcGksIGFueSBkYXRhIGNoYW5nZSB0aGF0IGltcGFjdHMgdGhlIGFwaSByZXN1bHQgV0lMTCBiZSBQVVNIZWQgdG8gdGhlIGNsaWVudC5cbiAgICAgICAgICogSWYgdGhlIGNsaWVudCBkb2VzIE5PVCBzdWJzY3JpYmUgb3Igc3RvcCBzdWJzY3JpYmUsIGl0IHdpbGwgbm8gbG9uZ2VyIHJlY2VpdmUgdGhlIFBVU0guIFxuICAgICAgICAgKiAgICBcbiAgICAgICAgICogaWYgdGhlIGNvbm5lY3Rpb24gaXMgbG9zdCBmb3IgYSBzaG9ydCB0aW1lIChkdXJhdGlvbiBkZWZpbmVkIG9uIHNlcnZlci1zaWRlKSwgdGhlIHNlcnZlciBxdWV1ZXMgdGhlIGNoYW5nZXMgaWYgYW55LiBcbiAgICAgICAgICogV2hlbiB0aGUgY29ubmVjdGlvbiByZXR1cm5zLCB0aGUgbWlzc2luZyBkYXRhIGF1dG9tYXRpY2FsbHkgIHdpbGwgYmUgUFVTSGVkIHRvIHRoZSBzdWJzY3JpYmluZyBjbGllbnQuXG4gICAgICAgICAqIGlmIHRoZSBjb25uZWN0aW9uIGlzIGxvc3QgZm9yIGEgbG9uZyB0aW1lIChkdXJhdGlvbiBkZWZpbmVkIG9uIHRoZSBzZXJ2ZXIpLCB0aGUgc2VydmVyIHdpbGwgZGVzdHJveSB0aGUgc3Vic2NyaXB0aW9uLiBUbyBzaW1wbGlmeSwgdGhlIGNsaWVudCB3aWxsIHJlc3Vic2NyaWJlIGF0IGl0cyByZWNvbm5lY3Rpb24gYW5kIGdldCBhbGwgZGF0YS5cbiAgICAgICAgICogXG4gICAgICAgICAqIHN1YnNjcmlwdGlvbiBvYmplY3QgcHJvdmlkZXMgMyBjYWxsYmFja3MgKGFkZCx1cGRhdGUsIGRlbCkgd2hpY2ggYXJlIGNhbGxlZCBkdXJpbmcgc3luY2hyb25pemF0aW9uLlxuICAgICAgICAgKiAgICAgIFxuICAgICAgICAgKiBTY29wZSB3aWxsIGFsbG93IHRoZSBzdWJzY3JpcHRpb24gc3RvcCBzeW5jaHJvbml6aW5nIGFuZCBjYW5jZWwgcmVnaXN0cmF0aW9uIHdoZW4gaXQgaXMgZGVzdHJveWVkLiBcbiAgICAgICAgICogIFxuICAgICAgICAgKiBDb25zdHJ1Y3RvcjpcbiAgICAgICAgICogXG4gICAgICAgICAqIEBwYXJhbSBwdWJsaWNhdGlvbiwgdGhlIHB1YmxpY2F0aW9uIG11c3QgZXhpc3Qgb24gdGhlIHNlcnZlciBzaWRlXG4gICAgICAgICAqIEBwYXJhbSBzY29wZSwgYnkgZGVmYXVsdCAkcm9vdFNjb3BlLCBidXQgY2FuIGJlIG1vZGlmaWVkIGxhdGVyIG9uIHdpdGggYXR0YWNoIG1ldGhvZC5cbiAgICAgICAgICovXG5cbiAgICAgICAgZnVuY3Rpb24gU3Vic2NyaXB0aW9uKHB1YmxpY2F0aW9uLCBzY29wZSkge1xuICAgICAgICAgICAgdmFyIHRpbWVzdGFtcEZpZWxkLCBpc1N5bmNpbmdPbiA9IGZhbHNlLCBpc1NpbmdsZSwgdXBkYXRlRGF0YVN0b3JhZ2UsIGNhY2hlLCBpc0luaXRpYWxQdXNoQ29tcGxldGVkLCBkZWZlcnJlZEluaXRpYWxpemF0aW9uLCBzdHJpY3RNb2RlO1xuICAgICAgICAgICAgdmFyIG9uUmVhZHlPZmYsIGZvcm1hdFJlY29yZDtcbiAgICAgICAgICAgIHZhciByZWNvbm5lY3RPZmYsIHB1YmxpY2F0aW9uTGlzdGVuZXJPZmYsIGRlc3Ryb3lPZmY7XG4gICAgICAgICAgICB2YXIgb2JqZWN0Q2xhc3M7XG4gICAgICAgICAgICB2YXIgc3Vic2NyaXB0aW9uSWQ7XG5cbiAgICAgICAgICAgIHZhciBzRHMgPSB0aGlzO1xuICAgICAgICAgICAgdmFyIHN1YlBhcmFtcyA9IHt9O1xuICAgICAgICAgICAgdmFyIHJlY29yZFN0YXRlcyA9IHt9O1xuICAgICAgICAgICAgdmFyIGlubmVyU2NvcGU7Ly89ICRyb290U2NvcGUuJG5ldyh0cnVlKTtcbiAgICAgICAgICAgIHZhciBzeW5jTGlzdGVuZXIgPSBuZXcgU3luY0xpc3RlbmVyKCk7XG5cblxuICAgICAgICAgICAgdGhpcy5yZWFkeSA9IGZhbHNlO1xuICAgICAgICAgICAgdGhpcy5zeW5jT24gPSBzeW5jT247XG4gICAgICAgICAgICB0aGlzLnN5bmNPZmYgPSBzeW5jT2ZmO1xuICAgICAgICAgICAgdGhpcy5zZXRPblJlYWR5ID0gc2V0T25SZWFkeTtcblxuICAgICAgICAgICAgdGhpcy5vblJlYWR5ID0gb25SZWFkeTtcbiAgICAgICAgICAgIHRoaXMub25VcGRhdGUgPSBvblVwZGF0ZTtcbiAgICAgICAgICAgIHRoaXMub25BZGQgPSBvbkFkZDtcbiAgICAgICAgICAgIHRoaXMub25SZW1vdmUgPSBvblJlbW92ZTtcblxuICAgICAgICAgICAgdGhpcy5nZXREYXRhID0gZ2V0RGF0YTtcbiAgICAgICAgICAgIHRoaXMuc2V0UGFyYW1ldGVycyA9IHNldFBhcmFtZXRlcnM7XG5cbiAgICAgICAgICAgIHRoaXMud2FpdEZvckRhdGFSZWFkeSA9IHdhaXRGb3JEYXRhUmVhZHk7XG4gICAgICAgICAgICB0aGlzLndhaXRGb3JTdWJzY3JpcHRpb25SZWFkeSA9IHdhaXRGb3JTdWJzY3JpcHRpb25SZWFkeTtcblxuICAgICAgICAgICAgdGhpcy5zZXRGb3JjZSA9IHNldEZvcmNlO1xuICAgICAgICAgICAgdGhpcy5pc1N5bmNpbmcgPSBpc1N5bmNpbmc7XG4gICAgICAgICAgICB0aGlzLmlzUmVhZHkgPSBpc1JlYWR5O1xuXG4gICAgICAgICAgICB0aGlzLnNldFNpbmdsZSA9IHNldFNpbmdsZTtcblxuICAgICAgICAgICAgdGhpcy5zZXRPYmplY3RDbGFzcyA9IHNldE9iamVjdENsYXNzO1xuICAgICAgICAgICAgdGhpcy5nZXRPYmplY3RDbGFzcyA9IGdldE9iamVjdENsYXNzO1xuXG4gICAgICAgICAgICB0aGlzLnNldFN0cmljdE1vZGUgPSBzZXRTdHJpY3RNb2RlO1xuXG4gICAgICAgICAgICB0aGlzLmF0dGFjaCA9IGF0dGFjaDtcbiAgICAgICAgICAgIHRoaXMuZGVzdHJveSA9IGRlc3Ryb3k7XG5cbiAgICAgICAgICAgIHRoaXMuaXNFeGlzdGluZ1N0YXRlRm9yID0gaXNFeGlzdGluZ1N0YXRlRm9yOyAvLyBmb3IgdGVzdGluZyBwdXJwb3Nlc1xuXG4gICAgICAgICAgICBzZXRTaW5nbGUoZmFsc2UpO1xuXG4gICAgICAgICAgICAvLyB0aGlzIHdpbGwgbWFrZSBzdXJlIHRoYXQgdGhlIHN1YnNjcmlwdGlvbiBpcyByZWxlYXNlZCBmcm9tIHNlcnZlcnMgaWYgdGhlIGFwcCBjbG9zZXMgKGNsb3NlIGJyb3dzZXIsIHJlZnJlc2guLi4pXG4gICAgICAgICAgICBhdHRhY2goc2NvcGUgfHwgJHJvb3RTY29wZSk7XG5cbiAgICAgICAgICAgIC8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy9cblxuICAgICAgICAgICAgZnVuY3Rpb24gZGVzdHJveSgpIHtcbiAgICAgICAgICAgICAgICBzeW5jT2ZmKCk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKiB0aGlzIHdpbGwgYmUgY2FsbGVkIHdoZW4gZGF0YSBpcyBhdmFpbGFibGUgXG4gICAgICAgICAgICAgKiAgaXQgbWVhbnMgcmlnaHQgYWZ0ZXIgZWFjaCBzeW5jIVxuICAgICAgICAgICAgICogXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBzZXRPblJlYWR5KGNhbGxiYWNrKSB7XG4gICAgICAgICAgICAgICAgaWYgKG9uUmVhZHlPZmYpIHtcbiAgICAgICAgICAgICAgICAgICAgb25SZWFkeU9mZigpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBvblJlYWR5T2ZmID0gb25SZWFkeShjYWxsYmFjayk7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgKiBmb3JjZSByZXN5bmNpbmcgZnJvbSBzY3JhdGNoIGV2ZW4gaWYgdGhlIHBhcmFtZXRlcnMgaGF2ZSBub3QgY2hhbmdlZFxuICAgICAgICAgICAgICogXG4gICAgICAgICAgICAgKiBpZiBvdXRzaWRlIGNvZGUgaGFzIG1vZGlmaWVkIHRoZSBkYXRhIGFuZCB5b3UgbmVlZCB0byByb2xsYmFjaywgeW91IGNvdWxkIGNvbnNpZGVyIGZvcmNpbmcgYSByZWZyZXNoIHdpdGggdGhpcy4gQmV0dGVyIHNvbHV0aW9uIHNob3VsZCBiZSBmb3VuZCB0aGFuIHRoYXQuXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICAqL1xuICAgICAgICAgICAgZnVuY3Rpb24gc2V0Rm9yY2UodmFsdWUpIHtcbiAgICAgICAgICAgICAgICBpZiAodmFsdWUpIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gcXVpY2sgaGFjayB0byBmb3JjZSB0byByZWxvYWQuLi5yZWNvZGUgbGF0ZXIuXG4gICAgICAgICAgICAgICAgICAgIHNEcy5zeW5jT2ZmKCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogaWYgc2V0IHRvIHRydWUsIGlmIGFuIG9iamVjdCB3aXRoaW4gYW4gYXJyYXkgcHJvcGVydHkgb2YgdGhlIHJlY29yZCB0byBzeW5jIGhhcyBubyBJRCBmaWVsZC5cbiAgICAgICAgICAgICAqIGFuIGVycm9yIHdvdWxkIGJlIHRocm93bi5cbiAgICAgICAgICAgICAqIEl0IGlzIGltcG9ydGFudCBpZiB3ZSB3YW50IHRvIGJlIGFibGUgdG8gbWFpbnRhaW4gaW5zdGFuY2UgcmVmZXJlbmNlcyBldmVuIGZvciB0aGUgb2JqZWN0cyBpbnNpZGUgYXJyYXlzLlxuICAgICAgICAgICAgICpcbiAgICAgICAgICAgICAqIEZvcmNlcyB1cyB0byB1c2UgaWQgZXZlcnkgd2hlcmUuXG4gICAgICAgICAgICAgKlxuICAgICAgICAgICAgICogU2hvdWxkIGJlIHRoZSBkZWZhdWx0Li4uYnV0IHRvbyByZXN0cmljdGl2ZSBmb3Igbm93LlxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBzZXRTdHJpY3RNb2RlKHZhbHVlKSB7XG4gICAgICAgICAgICAgICAgc3RyaWN0TW9kZSA9IHZhbHVlO1xuICAgICAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogVGhlIGZvbGxvd2luZyBvYmplY3Qgd2lsbCBiZSBidWlsdCB1cG9uIGVhY2ggcmVjb3JkIHJlY2VpdmVkIGZyb20gdGhlIGJhY2tlbmRcbiAgICAgICAgICAgICAqIFxuICAgICAgICAgICAgICogVGhpcyBjYW5ub3QgYmUgbW9kaWZpZWQgYWZ0ZXIgdGhlIHN5bmMgaGFzIHN0YXJ0ZWQuXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICAqIEBwYXJhbSBjbGFzc1ZhbHVlXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIHNldE9iamVjdENsYXNzKGNsYXNzVmFsdWUpIHtcbiAgICAgICAgICAgICAgICBpZiAoZGVmZXJyZWRJbml0aWFsaXphdGlvbikge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIG9iamVjdENsYXNzID0gY2xhc3NWYWx1ZTtcbiAgICAgICAgICAgICAgICBmb3JtYXRSZWNvcmQgPSBmdW5jdGlvbiAocmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBuZXcgb2JqZWN0Q2xhc3MocmVjb3JkKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgc2V0U2luZ2xlKGlzU2luZ2xlKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBnZXRPYmplY3RDbGFzcygpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gb2JqZWN0Q2xhc3M7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogdGhpcyBmdW5jdGlvbiBzdGFydHMgdGhlIHN5bmNpbmcuXG4gICAgICAgICAgICAgKiBPbmx5IHB1YmxpY2F0aW9uIHB1c2hpbmcgZGF0YSBtYXRjaGluZyBvdXIgZmV0Y2hpbmcgcGFyYW1zIHdpbGwgYmUgcmVjZWl2ZWQuXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICAqIGV4OiBmb3IgYSBwdWJsaWNhdGlvbiBuYW1lZCBcIm1hZ2F6aW5lcy5zeW5jXCIsIGlmIGZldGNoaW5nIHBhcmFtcyBlcXVhbGxlZCB7bWFnYXppbk5hbWU6J2NhcnMnfSwgdGhlIG1hZ2F6aW5lIGNhcnMgZGF0YSB3b3VsZCBiZSByZWNlaXZlZCBieSB0aGlzIHN1YnNjcmlwdGlvbi5cbiAgICAgICAgICAgICAqIFxuICAgICAgICAgICAgICogQHBhcmFtIGZldGNoaW5nUGFyYW1zXG4gICAgICAgICAgICAgKiBAcGFyYW0gb3B0aW9uc1xuICAgICAgICAgICAgICogXG4gICAgICAgICAgICAgKiBAcmV0dXJucyBhIHByb21pc2UgdGhhdCByZXNvbHZlcyB3aGVuIGRhdGEgaXMgYXJyaXZlZC5cbiAgICAgICAgICAgICAqL1xuICAgICAgICAgICAgZnVuY3Rpb24gc2V0UGFyYW1ldGVycyhmZXRjaGluZ1BhcmFtcywgb3B0aW9ucykge1xuICAgICAgICAgICAgICAgIGlmIChpc1N5bmNpbmdPbiAmJiBhbmd1bGFyLmVxdWFscyhmZXRjaGluZ1BhcmFtcyB8fCB7fSwgc3ViUGFyYW1zKSkge1xuICAgICAgICAgICAgICAgICAgICAvLyBpZiB0aGUgcGFyYW1zIGhhdmUgbm90IGNoYW5nZWQsIGp1c3QgcmV0dXJucyB3aXRoIGN1cnJlbnQgZGF0YS5cbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHNEczsgLy8kcS5yZXNvbHZlKGdldERhdGEoKSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHN5bmNPZmYoKTtcbiAgICAgICAgICAgICAgICBpZiAoIWlzU2luZ2xlKSB7XG4gICAgICAgICAgICAgICAgICAgIGNhY2hlLmxlbmd0aCA9IDA7XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgc3ViUGFyYW1zID0gZmV0Y2hpbmdQYXJhbXMgfHwge307XG4gICAgICAgICAgICAgICAgb3B0aW9ucyA9IG9wdGlvbnMgfHwge307XG4gICAgICAgICAgICAgICAgaWYgKGFuZ3VsYXIuaXNEZWZpbmVkKG9wdGlvbnMuc2luZ2xlKSkge1xuICAgICAgICAgICAgICAgICAgICBzZXRTaW5nbGUob3B0aW9ucy5zaW5nbGUpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBzdGFydFN5bmNpbmcoKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqIEByZXR1cm5zIGEgcHJvbWlzZSB0aGF0IHdhaXRzIGZvciB0aGUgaW5pdGlhbCBmZXRjaCB0byBjb21wbGV0ZSB0aGVuIHdhaXQgZm9yIHRoZSBpbml0aWFsIGZldGNoIHRvIGNvbXBsZXRlIHRoZW4gcmV0dXJucyB0aGlzIHN1YnNjcmlwdGlvbi5cbiAgICAgICAgICAgICAqL1xuICAgICAgICAgICAgZnVuY3Rpb24gd2FpdEZvclN1YnNjcmlwdGlvblJlYWR5KCkge1xuICAgICAgICAgICAgICAgIHJldHVybiBzdGFydFN5bmNpbmcoKS50aGVuKGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgKiBAcmV0dXJucyBhIHByb21pc2UgdGhhdCB3YWl0cyBmb3IgdGhlIGluaXRpYWwgZmV0Y2ggdG8gY29tcGxldGUgdGhlbiByZXR1cm5zIHRoZSBkYXRhXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIHdhaXRGb3JEYXRhUmVhZHkoKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHN0YXJ0U3luY2luZygpO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvLyBkb2VzIHRoZSBkYXRhc2V0IHJldHVybnMgb25seSBvbmUgb2JqZWN0PyBub3QgYW4gYXJyYXk/XG4gICAgICAgICAgICBmdW5jdGlvbiBzZXRTaW5nbGUodmFsdWUpIHtcbiAgICAgICAgICAgICAgICBpZiAoZGVmZXJyZWRJbml0aWFsaXphdGlvbikge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHZhciB1cGRhdGVGbjtcbiAgICAgICAgICAgICAgICBpc1NpbmdsZSA9IHZhbHVlO1xuICAgICAgICAgICAgICAgIGlmICh2YWx1ZSkge1xuICAgICAgICAgICAgICAgICAgICB1cGRhdGVGbiA9IHVwZGF0ZVN5bmNlZE9iamVjdDtcbiAgICAgICAgICAgICAgICAgICAgY2FjaGUgPSBvYmplY3RDbGFzcyA/IG5ldyBvYmplY3RDbGFzcyh7fSkgOiB7fTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICB1cGRhdGVGbiA9IHVwZGF0ZVN5bmNlZEFycmF5O1xuICAgICAgICAgICAgICAgICAgICBjYWNoZSA9IFtdO1xuICAgICAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgICAgIHVwZGF0ZURhdGFTdG9yYWdlID0gZnVuY3Rpb24gKHJlY29yZCkge1xuICAgICAgICAgICAgICAgICAgICB0cnkge1xuICAgICAgICAgICAgICAgICAgICAgICAgdXBkYXRlRm4ocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgfSBjYXRjaCAoZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgZS5tZXNzYWdlID0gJ1JlY2VpdmVkIEludmFsaWQgb2JqZWN0IGZyb20gcHVibGljYXRpb24gWycgKyBwdWJsaWNhdGlvbiArICddOiAnICsgSlNPTi5zdHJpbmdpZnkocmVjb3JkKSArICcuIERFVEFJTFM6ICcgKyBlLm1lc3NhZ2U7XG4gICAgICAgICAgICAgICAgICAgICAgICB0aHJvdyBlO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLy8gcmV0dXJucyB0aGUgb2JqZWN0IG9yIGFycmF5IGluIHN5bmNcbiAgICAgICAgICAgIGZ1bmN0aW9uIGdldERhdGEoKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGNhY2hlO1xuICAgICAgICAgICAgfVxuXG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogQWN0aXZhdGUgc3luY2luZ1xuICAgICAgICAgICAgICpcbiAgICAgICAgICAgICAqIEByZXR1cm5zIHRoaXMgc3ViY3JpcHRpb25cbiAgICAgICAgICAgICAqXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIHN5bmNPbigpIHtcbiAgICAgICAgICAgICAgICBzdGFydFN5bmNpbmcoKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICAgICAgfVxuXG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogRGVhY3RpdmF0ZSBzeW5jaW5nXG4gICAgICAgICAgICAgKlxuICAgICAgICAgICAgICogdGhlIGRhdGFzZXQgaXMgbm8gbG9uZ2VyIGxpc3RlbmluZyBhbmQgd2lsbCBub3QgY2FsbCBhbnkgY2FsbGJhY2tcbiAgICAgICAgICAgICAqXG4gICAgICAgICAgICAgKiBAcmV0dXJucyB0aGlzIHN1YmNyaXB0aW9uXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIHN5bmNPZmYoKSB7XG4gICAgICAgICAgICAgICAgaWYgKGRlZmVycmVkSW5pdGlhbGl6YXRpb24pIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gaWYgdGhlcmUgaXMgY29kZSB3YWl0aW5nIG9uIHRoaXMgcHJvbWlzZS4uIGV4IChsb2FkIGluIHJlc29sdmUpXG4gICAgICAgICAgICAgICAgICAgIGRlZmVycmVkSW5pdGlhbGl6YXRpb24ucmVzb2x2ZShnZXREYXRhKCkpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBpZiAoaXNTeW5jaW5nT24pIHtcbiAgICAgICAgICAgICAgICAgICAgdW5yZWdpc3RlclN1YnNjcmlwdGlvbigpO1xuICAgICAgICAgICAgICAgICAgICBpc1N5bmNpbmdPbiA9IGZhbHNlO1xuXG4gICAgICAgICAgICAgICAgICAgIGxvZ0luZm8oJ1N5bmMgJyArIHB1YmxpY2F0aW9uICsgJyBvZmYuIFBhcmFtczonICsgSlNPTi5zdHJpbmdpZnkoc3ViUGFyYW1zKSk7XG4gICAgICAgICAgICAgICAgICAgIGlmIChwdWJsaWNhdGlvbkxpc3RlbmVyT2ZmKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBwdWJsaWNhdGlvbkxpc3RlbmVyT2ZmKCk7XG4gICAgICAgICAgICAgICAgICAgICAgICBwdWJsaWNhdGlvbkxpc3RlbmVyT2ZmID0gbnVsbDtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBpZiAocmVjb25uZWN0T2ZmKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZWNvbm5lY3RPZmYoKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIHJlY29ubmVjdE9mZiA9IG51bGw7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgKiB0aGUgZGF0YXNldCB3aWxsIHN0YXJ0IGxpc3RlbmluZyB0byB0aGUgZGF0YXN0cmVhbSBcbiAgICAgICAgICAgICAqIFxuICAgICAgICAgICAgICogTm90ZSBEdXJpbmcgdGhlIHN5bmMsIGl0IHdpbGwgYWxzbyBjYWxsIHRoZSBvcHRpb25hbCBjYWxsYmFja3MgLSBhZnRlciBwcm9jZXNzaW5nIEVBQ0ggcmVjb3JkIHJlY2VpdmVkLlxuICAgICAgICAgICAgICogXG4gICAgICAgICAgICAgKiBAcmV0dXJucyBhIHByb21pc2UgdGhhdCB3aWxsIGJlIHJlc29sdmVkIHdoZW4gdGhlIGRhdGEgaXMgcmVhZHkuXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIHN0YXJ0U3luY2luZygpIHtcbiAgICAgICAgICAgICAgICBpZiAoaXNTeW5jaW5nT24pIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIGRlZmVycmVkSW5pdGlhbGl6YXRpb24ucHJvbWlzZTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgZGVmZXJyZWRJbml0aWFsaXphdGlvbiA9ICRxLmRlZmVyKCk7XG4gICAgICAgICAgICAgICAgaXNJbml0aWFsUHVzaENvbXBsZXRlZCA9IGZhbHNlO1xuICAgICAgICAgICAgICAgIGxvZ0luZm8oJ1N5bmMgJyArIHB1YmxpY2F0aW9uICsgJyBvbi4gUGFyYW1zOicgKyBKU09OLnN0cmluZ2lmeShzdWJQYXJhbXMpKTtcbiAgICAgICAgICAgICAgICBpc1N5bmNpbmdPbiA9IHRydWU7XG4gICAgICAgICAgICAgICAgcmVnaXN0ZXJTdWJzY3JpcHRpb24oKTtcbiAgICAgICAgICAgICAgICByZWFkeUZvckxpc3RlbmluZygpO1xuICAgICAgICAgICAgICAgIHJldHVybiBkZWZlcnJlZEluaXRpYWxpemF0aW9uLnByb21pc2U7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIGlzU3luY2luZygpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gaXNTeW5jaW5nT247XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIHJlYWR5Rm9yTGlzdGVuaW5nKCkge1xuICAgICAgICAgICAgICAgIGlmICghcHVibGljYXRpb25MaXN0ZW5lck9mZikge1xuICAgICAgICAgICAgICAgICAgICBsaXN0ZW5Gb3JSZWNvbm5lY3Rpb25Ub1Jlc3luYygpO1xuICAgICAgICAgICAgICAgICAgICBsaXN0ZW5Ub1B1YmxpY2F0aW9uKCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICAvKipcbiAgICAgICAgICAgICAqICBCeSBkZWZhdWx0IHRoZSByb290c2NvcGUgaXMgYXR0YWNoZWQgaWYgbm8gc2NvcGUgd2FzIHByb3ZpZGVkLiBCdXQgaXQgaXMgcG9zc2libGUgdG8gcmUtYXR0YWNoIGl0IHRvIGEgZGlmZmVyZW50IHNjb3BlLiBpZiB0aGUgc3Vic2NyaXB0aW9uIGRlcGVuZHMgb24gYSBjb250cm9sbGVyLlxuICAgICAgICAgICAgICpcbiAgICAgICAgICAgICAqICBEbyBub3QgYXR0YWNoIGFmdGVyIGl0IGhhcyBzeW5jZWQuXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIGF0dGFjaChuZXdTY29wZSkge1xuICAgICAgICAgICAgICAgIGlmIChkZWZlcnJlZEluaXRpYWxpemF0aW9uKSB7XG4gICAgICAgICAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGlmIChkZXN0cm95T2ZmKSB7XG4gICAgICAgICAgICAgICAgICAgIGRlc3Ryb3lPZmYoKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgaW5uZXJTY29wZSA9IG5ld1Njb3BlO1xuICAgICAgICAgICAgICAgIGRlc3Ryb3lPZmYgPSBpbm5lclNjb3BlLiRvbignJGRlc3Ryb3knLCBkZXN0cm95KTtcblxuICAgICAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIGxpc3RlbkZvclJlY29ubmVjdGlvblRvUmVzeW5jKGxpc3Rlbk5vdykge1xuICAgICAgICAgICAgICAgIC8vIGdpdmUgYSBjaGFuY2UgdG8gY29ubmVjdCBiZWZvcmUgbGlzdGVuaW5nIHRvIHJlY29ubmVjdGlvbi4uLiBAVE9ETyBzaG91bGQgaGF2ZSB1c2VyX3JlY29ubmVjdGVkX2V2ZW50XG4gICAgICAgICAgICAgICAgc2V0VGltZW91dChmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgICAgIHJlY29ubmVjdE9mZiA9IGlubmVyU2NvcGUuJG9uKCd1c2VyX2Nvbm5lY3RlZCcsIGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGxvZ0RlYnVnKCdSZXN5bmNpbmcgYWZ0ZXIgbmV0d29yayBsb3NzIHRvICcgKyBwdWJsaWNhdGlvbik7XG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBub3RlIHRoZSBiYWNrZW5kIG1pZ2h0IHJldHVybiBhIG5ldyBzdWJzY3JpcHRpb24gaWYgdGhlIGNsaWVudCB0b29rIHRvbyBtdWNoIHRpbWUgdG8gcmVjb25uZWN0LlxuICAgICAgICAgICAgICAgICAgICAgICAgcmVnaXN0ZXJTdWJzY3JpcHRpb24oKTtcbiAgICAgICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgfSwgbGlzdGVuTm93ID8gMCA6IDIwMDApO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiByZWdpc3RlclN1YnNjcmlwdGlvbigpIHtcbiAgICAgICAgICAgICAgICAkc29ja2V0aW8uZmV0Y2goJ3N5bmMuc3Vic2NyaWJlJywge1xuICAgICAgICAgICAgICAgICAgICB2ZXJzaW9uOiBTWU5DX1ZFUlNJT04sXG4gICAgICAgICAgICAgICAgICAgIGlkOiBzdWJzY3JpcHRpb25JZCwgLy8gdG8gdHJ5IHRvIHJlLXVzZSBleGlzdGluZyBzdWJjcmlwdGlvblxuICAgICAgICAgICAgICAgICAgICBwdWJsaWNhdGlvbjogcHVibGljYXRpb24sXG4gICAgICAgICAgICAgICAgICAgIHBhcmFtczogc3ViUGFyYW1zXG4gICAgICAgICAgICAgICAgfSkudGhlbihmdW5jdGlvbiAoc3ViSWQpIHtcbiAgICAgICAgICAgICAgICAgICAgc3Vic2NyaXB0aW9uSWQgPSBzdWJJZDtcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gdW5yZWdpc3RlclN1YnNjcmlwdGlvbigpIHtcbiAgICAgICAgICAgICAgICBpZiAoc3Vic2NyaXB0aW9uSWQpIHtcbiAgICAgICAgICAgICAgICAgICAgJHNvY2tldGlvLmZldGNoKCdzeW5jLnVuc3Vic2NyaWJlJywge1xuICAgICAgICAgICAgICAgICAgICAgICAgdmVyc2lvbjogU1lOQ19WRVJTSU9OLFxuICAgICAgICAgICAgICAgICAgICAgICAgaWQ6IHN1YnNjcmlwdGlvbklkXG4gICAgICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgICAgICBzdWJzY3JpcHRpb25JZCA9IG51bGw7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBsaXN0ZW5Ub1B1YmxpY2F0aW9uKCkge1xuICAgICAgICAgICAgICAgIC8vIGNhbm5vdCBvbmx5IGxpc3RlbiB0byBzdWJzY3JpcHRpb25JZCB5ZXQuLi5iZWNhdXNlIHRoZSByZWdpc3RyYXRpb24gbWlnaHQgaGF2ZSBhbnN3ZXIgcHJvdmlkZWQgaXRzIGlkIHlldC4uLmJ1dCBzdGFydGVkIGJyb2FkY2FzdGluZyBjaGFuZ2VzLi4uQFRPRE8gY2FuIGJlIGltcHJvdmVkLi4uXG4gICAgICAgICAgICAgICAgcHVibGljYXRpb25MaXN0ZW5lck9mZiA9IGFkZFB1YmxpY2F0aW9uTGlzdGVuZXIocHVibGljYXRpb24sIGZ1bmN0aW9uIChiYXRjaCkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoc3Vic2NyaXB0aW9uSWQgPT09IGJhdGNoLnN1YnNjcmlwdGlvbklkIHx8ICghc3Vic2NyaXB0aW9uSWQgJiYgY2hlY2tEYXRhU2V0UGFyYW1zSWZNYXRjaGluZ0JhdGNoUGFyYW1zKGJhdGNoLnBhcmFtcykpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWJhdGNoLmRpZmYpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICAvLyBDbGVhciB0aGUgY2FjaGUgdG8gcmVidWlsZCBpdCBpZiBhbGwgZGF0YSB3YXMgcmVjZWl2ZWQuXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVjb3JkU3RhdGVzID0ge307XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFpc1NpbmdsZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYWNoZS5sZW5ndGggPSAwO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgICAgIGFwcGx5Q2hhbmdlcyhiYXRjaC5yZWNvcmRzKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghaXNJbml0aWFsUHVzaENvbXBsZXRlZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGlzSW5pdGlhbFB1c2hDb21wbGV0ZWQgPSB0cnVlO1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGRlZmVycmVkSW5pdGlhbGl6YXRpb24ucmVzb2x2ZShnZXREYXRhKCkpO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgKiBpZiB0aGUgcGFyYW1zIG9mIHRoZSBkYXRhc2V0IG1hdGNoZXMgdGhlIG5vdGlmaWNhdGlvbiwgaXQgbWVhbnMgdGhlIGRhdGEgbmVlZHMgdG8gYmUgY29sbGVjdCB0byB1cGRhdGUgYXJyYXkuXG4gICAgICAgICAgICAqL1xuICAgICAgICAgICAgZnVuY3Rpb24gY2hlY2tEYXRhU2V0UGFyYW1zSWZNYXRjaGluZ0JhdGNoUGFyYW1zKGJhdGNoUGFyYW1zKSB7XG4gICAgICAgICAgICAgICAgLy8gaWYgKHBhcmFtcy5sZW5ndGggIT0gc3RyZWFtUGFyYW1zLmxlbmd0aCkge1xuICAgICAgICAgICAgICAgIC8vICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICAgICAgLy8gfVxuICAgICAgICAgICAgICAgIGlmICghc3ViUGFyYW1zIHx8IE9iamVjdC5rZXlzKHN1YlBhcmFtcykubGVuZ3RoID09IDApIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHRydWVcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgdmFyIG1hdGNoaW5nID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICBmb3IgKHZhciBwYXJhbSBpbiBiYXRjaFBhcmFtcykge1xuICAgICAgICAgICAgICAgICAgICAvLyBhcmUgb3RoZXIgcGFyYW1zIG1hdGNoaW5nP1xuICAgICAgICAgICAgICAgICAgICAvLyBleDogd2UgbWlnaHQgaGF2ZSByZWNlaXZlIGEgbm90aWZpY2F0aW9uIGFib3V0IHRhc2tJZD0yMCBidXQgdGhpcyBzdWJzY3JpcHRpb24gYXJlIG9ubHkgaW50ZXJlc3RlZCBhYm91dCB0YXNrSWQtM1xuICAgICAgICAgICAgICAgICAgICBpZiAoYmF0Y2hQYXJhbXNbcGFyYW1dICE9PSBzdWJQYXJhbXNbcGFyYW1dKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBtYXRjaGluZyA9IGZhbHNlO1xuICAgICAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgcmV0dXJuIG1hdGNoaW5nO1xuXG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8vIGZldGNoIGFsbCB0aGUgbWlzc2luZyByZWNvcmRzLCBhbmQgYWN0aXZhdGUgdGhlIGNhbGwgYmFja3MgKGFkZCx1cGRhdGUscmVtb3ZlKSBhY2NvcmRpbmdseSBpZiB0aGVyZSBpcyBzb21ldGhpbmcgdGhhdCBpcyBuZXcgb3Igbm90IGFscmVhZHkgaW4gc3luYy5cbiAgICAgICAgICAgIGZ1bmN0aW9uIGFwcGx5Q2hhbmdlcyhyZWNvcmRzKSB7XG4gICAgICAgICAgICAgICAgdmFyIG5ld0RhdGFBcnJheSA9IFtdO1xuICAgICAgICAgICAgICAgIHZhciBuZXdEYXRhO1xuICAgICAgICAgICAgICAgIHNEcy5yZWFkeSA9IGZhbHNlO1xuICAgICAgICAgICAgICAgIHJlY29yZHMuZm9yRWFjaChmdW5jdGlvbiAocmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vICAgICAgICAgICAgICAgICAgIGxvZ0luZm8oJ0RhdGFzeW5jIFsnICsgZGF0YVN0cmVhbU5hbWUgKyAnXSByZWNlaXZlZDonICtKU09OLnN0cmluZ2lmeShyZWNvcmQpKTsvLysgSlNPTi5zdHJpbmdpZnkocmVjb3JkLmlkKSk7XG4gICAgICAgICAgICAgICAgICAgIGlmIChyZWNvcmQucmVtb3ZlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICByZW1vdmVSZWNvcmQocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgfSBlbHNlIGlmIChnZXRSZWNvcmRTdGF0ZShyZWNvcmQpKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBpZiB0aGUgcmVjb3JkIGlzIGFscmVhZHkgcHJlc2VudCBpbiB0aGUgY2FjaGUuLi5zbyBpdCBpcyBtaWdodGJlIGFuIHVwZGF0ZS4uXG4gICAgICAgICAgICAgICAgICAgICAgICBuZXdEYXRhID0gdXBkYXRlUmVjb3JkKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBuZXdEYXRhID0gYWRkUmVjb3JkKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgaWYgKG5ld0RhdGEpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIG5ld0RhdGFBcnJheS5wdXNoKG5ld0RhdGEpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgc0RzLnJlYWR5ID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICBpZiAoaXNTaW5nbGUpIHtcbiAgICAgICAgICAgICAgICAgICAgc3luY0xpc3RlbmVyLm5vdGlmeSgncmVhZHknLCBnZXREYXRhKCkpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIHN5bmNMaXN0ZW5lci5ub3RpZnkoJ3JlYWR5JywgZ2V0RGF0YSgpLCBuZXdEYXRhQXJyYXkpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgKiBBbHRob3VnaCBtb3N0IGNhc2VzIGFyZSBoYW5kbGVkIHVzaW5nIG9uUmVhZHksIHRoaXMgdGVsbHMgeW91IHRoZSBjdXJyZW50IGRhdGEgc3RhdGUuXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICAqIEByZXR1cm5zIGlmIHRydWUgaXMgYSBzeW5jIGhhcyBiZWVuIHByb2Nlc3NlZCBvdGhlcndpc2UgZmFsc2UgaWYgdGhlIGRhdGEgaXMgbm90IHJlYWR5LlxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBpc1JlYWR5KCkge1xuICAgICAgICAgICAgICAgIHJldHVybiB0aGlzLnJlYWR5O1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICAqIHJldHVybnMgYSBmdW5jdGlvbiB0byByZW1vdmUgdGhlIGxpc3RlbmVyLlxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBvbkFkZChjYWxsYmFjaykge1xuICAgICAgICAgICAgICAgIHJldHVybiBzeW5jTGlzdGVuZXIub24oJ2FkZCcsIGNhbGxiYWNrKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICAqIHJldHVybnMgYSBmdW5jdGlvbiB0byByZW1vdmUgdGhlIGxpc3RlbmVyLlxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBvblVwZGF0ZShjYWxsYmFjaykge1xuICAgICAgICAgICAgICAgIHJldHVybiBzeW5jTGlzdGVuZXIub24oJ3VwZGF0ZScsIGNhbGxiYWNrKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICAqIHJldHVybnMgYSBmdW5jdGlvbiB0byByZW1vdmUgdGhlIGxpc3RlbmVyLlxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBvblJlbW92ZShjYWxsYmFjaykge1xuICAgICAgICAgICAgICAgIHJldHVybiBzeW5jTGlzdGVuZXIub24oJ3JlbW92ZScsIGNhbGxiYWNrKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgLyoqXG4gICAgICAgICAgICAgKiBcbiAgICAgICAgICAgICAqIHJldHVybnMgYSBmdW5jdGlvbiB0byByZW1vdmUgdGhlIGxpc3RlbmVyLlxuICAgICAgICAgICAgICovXG4gICAgICAgICAgICBmdW5jdGlvbiBvblJlYWR5KGNhbGxiYWNrKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHN5bmNMaXN0ZW5lci5vbigncmVhZHknLCBjYWxsYmFjayk7XG4gICAgICAgICAgICB9XG5cblxuICAgICAgICAgICAgZnVuY3Rpb24gYWRkUmVjb3JkKHJlY29yZCkge1xuICAgICAgICAgICAgICAgIGxvZ0RlYnVnKCdTeW5jIC0+IEluc2VydGVkIE5ldyByZWNvcmQgIycgKyBKU09OLnN0cmluZ2lmeShyZWNvcmQuaWQpICsgJyBmb3Igc3Vic2NyaXB0aW9uIHRvICcgKyBwdWJsaWNhdGlvbik7Ly8gSlNPTi5zdHJpbmdpZnkocmVjb3JkKSk7XG4gICAgICAgICAgICAgICAgZ2V0UmV2aXNpb24ocmVjb3JkKTsgLy8ganVzdCBtYWtlIHN1cmUgd2UgY2FuIGdldCBhIHJldmlzaW9uIGJlZm9yZSB3ZSBoYW5kbGUgdGhpcyByZWNvcmRcbiAgICAgICAgICAgICAgICB1cGRhdGVEYXRhU3RvcmFnZShmb3JtYXRSZWNvcmQgPyBmb3JtYXRSZWNvcmQocmVjb3JkKSA6IHJlY29yZCk7XG4gICAgICAgICAgICAgICAgc3luY0xpc3RlbmVyLm5vdGlmeSgnYWRkJywgcmVjb3JkKTtcbiAgICAgICAgICAgICAgICByZXR1cm4gcmVjb3JkO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiB1cGRhdGVSZWNvcmQocmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgdmFyIHByZXZpb3VzID0gZ2V0UmVjb3JkU3RhdGUocmVjb3JkKTtcbiAgICAgICAgICAgICAgICBpZiAoZ2V0UmV2aXNpb24ocmVjb3JkKSA8PSBnZXRSZXZpc2lvbihwcmV2aW91cykpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGxvZ0RlYnVnKCdTeW5jIC0+IFVwZGF0ZWQgcmVjb3JkICMnICsgSlNPTi5zdHJpbmdpZnkocmVjb3JkLmlkKSArICcgZm9yIHN1YnNjcmlwdGlvbiB0byAnICsgcHVibGljYXRpb24pOy8vIEpTT04uc3RyaW5naWZ5KHJlY29yZCkpO1xuICAgICAgICAgICAgICAgIHVwZGF0ZURhdGFTdG9yYWdlKGZvcm1hdFJlY29yZCA/IGZvcm1hdFJlY29yZChyZWNvcmQpIDogcmVjb3JkKTtcbiAgICAgICAgICAgICAgICBzeW5jTGlzdGVuZXIubm90aWZ5KCd1cGRhdGUnLCByZWNvcmQpO1xuICAgICAgICAgICAgICAgIHJldHVybiByZWNvcmQ7XG4gICAgICAgICAgICB9XG5cblxuICAgICAgICAgICAgZnVuY3Rpb24gcmVtb3ZlUmVjb3JkKHJlY29yZCkge1xuICAgICAgICAgICAgICAgIHZhciBwcmV2aW91cyA9IGdldFJlY29yZFN0YXRlKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgaWYgKCFwcmV2aW91cyB8fCBnZXRSZXZpc2lvbihyZWNvcmQpID4gZ2V0UmV2aXNpb24ocHJldmlvdXMpKSB7XG4gICAgICAgICAgICAgICAgICAgIGxvZ0RlYnVnKCdTeW5jIC0+IFJlbW92ZWQgIycgKyBKU09OLnN0cmluZ2lmeShyZWNvcmQuaWQpICsgJyBmb3Igc3Vic2NyaXB0aW9uIHRvICcgKyBwdWJsaWNhdGlvbik7XG4gICAgICAgICAgICAgICAgICAgIC8vIFdlIGNvdWxkIGhhdmUgZm9yIHRoZSBzYW1lIHJlY29yZCBjb25zZWN1dGl2ZWx5IGZldGNoaW5nIGluIHRoaXMgb3JkZXI6XG4gICAgICAgICAgICAgICAgICAgIC8vIGRlbGV0ZSBpZDo0LCByZXYgMTAsIHRoZW4gYWRkIGlkOjQsIHJldiA5Li4uLiBieSBrZWVwaW5nIHRyYWNrIG9mIHdoYXQgd2FzIGRlbGV0ZWQsIHdlIHdpbGwgbm90IGFkZCB0aGUgcmVjb3JkIHNpbmNlIGl0IHdhcyBkZWxldGVkIHdpdGggYSBtb3N0IHJlY2VudCB0aW1lc3RhbXAuXG4gICAgICAgICAgICAgICAgICAgIHJlY29yZC5yZW1vdmVkID0gdHJ1ZTsgLy8gU28gd2Ugb25seSBmbGFnIGFzIHJlbW92ZWQsIGxhdGVyIG9uIHRoZSBnYXJiYWdlIGNvbGxlY3RvciB3aWxsIGdldCByaWQgb2YgaXQuICAgICAgICAgXG4gICAgICAgICAgICAgICAgICAgIHVwZGF0ZURhdGFTdG9yYWdlKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgIC8vIGlmIHRoZXJlIGlzIG5vIHByZXZpb3VzIHJlY29yZCB3ZSBkbyBub3QgbmVlZCB0byByZW1vdmVkIGFueSB0aGluZyBmcm9tIG91ciBzdG9yYWdlLiAgICAgXG4gICAgICAgICAgICAgICAgICAgIGlmIChwcmV2aW91cykge1xuICAgICAgICAgICAgICAgICAgICAgICAgc3luY0xpc3RlbmVyLm5vdGlmeSgncmVtb3ZlJywgcmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGRpc3Bvc2UocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGZ1bmN0aW9uIGRpc3Bvc2UocmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgJHN5bmNHYXJiYWdlQ29sbGVjdG9yLmRpc3Bvc2UoZnVuY3Rpb24gY29sbGVjdCgpIHtcbiAgICAgICAgICAgICAgICAgICAgdmFyIGV4aXN0aW5nUmVjb3JkID0gZ2V0UmVjb3JkU3RhdGUocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKGV4aXN0aW5nUmVjb3JkICYmIHJlY29yZC5yZXZpc2lvbiA+PSBleGlzdGluZ1JlY29yZC5yZXZpc2lvblxuICAgICAgICAgICAgICAgICAgICApIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vbG9nRGVidWcoJ0NvbGxlY3QgTm93OicgKyBKU09OLnN0cmluZ2lmeShyZWNvcmQpKTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGRlbGV0ZSByZWNvcmRTdGF0ZXNbZ2V0SWRWYWx1ZShyZWNvcmQuaWQpXTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBpc0V4aXN0aW5nU3RhdGVGb3IocmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuICEhZ2V0UmVjb3JkU3RhdGUocmVjb3JkKTtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgZnVuY3Rpb24gc2F2ZVJlY29yZFN0YXRlKHJlY29yZCkge1xuICAgICAgICAgICAgICAgIHJlY29yZFN0YXRlc1tnZXRJZFZhbHVlKHJlY29yZC5pZCldID0gcmVjb3JkO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBnZXRSZWNvcmRTdGF0ZShyZWNvcmQpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gcmVjb3JkU3RhdGVzW2dldElkVmFsdWUocmVjb3JkLmlkKV07XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIHVwZGF0ZVN5bmNlZE9iamVjdChyZWNvcmQpIHtcbiAgICAgICAgICAgICAgICBzYXZlUmVjb3JkU3RhdGUocmVjb3JkKTtcblxuICAgICAgICAgICAgICAgIGlmICghcmVjb3JkLnJlbW92ZSkge1xuICAgICAgICAgICAgICAgICAgICAkc3luY01lcmdlLnVwZGF0ZShjYWNoZSwgcmVjb3JkLCBzdHJpY3RNb2RlKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAkc3luY01lcmdlLmNsZWFyT2JqZWN0KGNhY2hlKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIHVwZGF0ZVN5bmNlZEFycmF5KHJlY29yZCkge1xuICAgICAgICAgICAgICAgIHZhciBleGlzdGluZyA9IGdldFJlY29yZFN0YXRlKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgaWYgKCFleGlzdGluZykge1xuICAgICAgICAgICAgICAgICAgICAvLyBhZGQgbmV3IGluc3RhbmNlXG4gICAgICAgICAgICAgICAgICAgIHNhdmVSZWNvcmRTdGF0ZShyZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICBpZiAoIXJlY29yZC5yZW1vdmVkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjYWNoZS5wdXNoKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICAkc3luY01lcmdlLnVwZGF0ZShleGlzdGluZywgcmVjb3JkLCBzdHJpY3RNb2RlKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKHJlY29yZC5yZW1vdmVkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjYWNoZS5zcGxpY2UoY2FjaGUuaW5kZXhPZihleGlzdGluZyksIDEpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBmdW5jdGlvbiBnZXRSZXZpc2lvbihyZWNvcmQpIHtcbiAgICAgICAgICAgICAgICAvLyB3aGF0IHJlc2VydmVkIGZpZWxkIGRvIHdlIHVzZSBhcyB0aW1lc3RhbXBcbiAgICAgICAgICAgICAgICBpZiAoYW5ndWxhci5pc0RlZmluZWQocmVjb3JkLnJldmlzaW9uKSkge1xuICAgICAgICAgICAgICAgICAgICByZXR1cm4gcmVjb3JkLnJldmlzaW9uO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBpZiAoYW5ndWxhci5pc0RlZmluZWQocmVjb3JkLnRpbWVzdGFtcCkpIHtcbiAgICAgICAgICAgICAgICAgICAgcmV0dXJuIHJlY29yZC50aW1lc3RhbXA7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignU3luYyByZXF1aXJlcyBhIHJldmlzaW9uIG9yIHRpbWVzdGFtcCBwcm9wZXJ0eSBpbiByZWNlaXZlZCAnICsgKG9iamVjdENsYXNzID8gJ29iamVjdCBbJyArIG9iamVjdENsYXNzLm5hbWUgKyAnXScgOiAncmVjb3JkJykpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqIHRoaXMgb2JqZWN0IFxuICAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gU3luY0xpc3RlbmVyKCkge1xuICAgICAgICAgICAgdmFyIGV2ZW50cyA9IHt9O1xuICAgICAgICAgICAgdmFyIGNvdW50ID0gMDtcblxuICAgICAgICAgICAgdGhpcy5ub3RpZnkgPSBub3RpZnk7XG4gICAgICAgICAgICB0aGlzLm9uID0gb247XG5cbiAgICAgICAgICAgIGZ1bmN0aW9uIG5vdGlmeShldmVudCwgZGF0YTEsIGRhdGEyKSB7XG4gICAgICAgICAgICAgICAgdmFyIGxpc3RlbmVycyA9IGV2ZW50c1tldmVudF07XG4gICAgICAgICAgICAgICAgaWYgKGxpc3RlbmVycykge1xuICAgICAgICAgICAgICAgICAgICBfLmZvckVhY2gobGlzdGVuZXJzLCBmdW5jdGlvbiAoY2FsbGJhY2ssIGlkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBjYWxsYmFjayhkYXRhMSwgZGF0YTIpO1xuICAgICAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIC8qKlxuICAgICAgICAgICAgICogQHJldHVybnMgaGFuZGxlciB0byB1bnJlZ2lzdGVyIGxpc3RlbmVyXG4gICAgICAgICAgICAgKi9cbiAgICAgICAgICAgIGZ1bmN0aW9uIG9uKGV2ZW50LCBjYWxsYmFjaykge1xuICAgICAgICAgICAgICAgIHZhciBsaXN0ZW5lcnMgPSBldmVudHNbZXZlbnRdO1xuICAgICAgICAgICAgICAgIGlmICghbGlzdGVuZXJzKSB7XG4gICAgICAgICAgICAgICAgICAgIGxpc3RlbmVycyA9IGV2ZW50c1tldmVudF0gPSB7fTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgdmFyIGlkID0gY291bnQrKztcbiAgICAgICAgICAgICAgICBsaXN0ZW5lcnNbaWQrK10gPSBjYWxsYmFjaztcbiAgICAgICAgICAgICAgICByZXR1cm4gZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgICAgICBkZWxldGUgbGlzdGVuZXJzW2lkXTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9O1xuICAgIGZ1bmN0aW9uIGdldElkVmFsdWUoaWQpIHtcbiAgICAgICAgaWYgKCFfLmlzT2JqZWN0KGlkKSkge1xuICAgICAgICAgICAgcmV0dXJuIGlkO1xuICAgICAgICB9XG4gICAgICAgIC8vIGJ1aWxkIGNvbXBvc2l0ZSBrZXkgdmFsdWVcbiAgICAgICAgdmFyIHIgPSBfLmpvaW4oXy5tYXAoaWQsIGZ1bmN0aW9uICh2YWx1ZSkge1xuICAgICAgICAgICAgcmV0dXJuIHZhbHVlO1xuICAgICAgICB9KSwgJ34nKTtcbiAgICAgICAgcmV0dXJuIHI7XG4gICAgfVxuXG5cbiAgICBmdW5jdGlvbiBsb2dJbmZvKG1zZykge1xuICAgICAgICBpZiAoZGVidWcpIHtcbiAgICAgICAgICAgIGNvbnNvbGUuZGVidWcoJ1NZTkMoaW5mbyk6ICcgKyBtc2cpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gbG9nRGVidWcobXNnKSB7XG4gICAgICAgIGlmIChkZWJ1ZyA9PSAyKSB7XG4gICAgICAgICAgICBjb25zb2xlLmRlYnVnKCdTWU5DKGRlYnVnKTogJyArIG1zZyk7XG4gICAgICAgIH1cblxuICAgIH1cblxuXG5cbn07XG5cbiJdfQ==
