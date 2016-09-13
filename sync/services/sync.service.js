
/**
 * 
 * Service that allows an array of data remain in sync with backend.
 * 
 * If network is lost, we load what we missed thanks to the timestamp..
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
    .factory('$sync', sync);

function sync($rootScope, $q, $socketio, $syncGarbageCollector) {
    var publicationListeners = {},
        publicationListenerCount = 0;
    var GRACE_PERIOD_IN_SECONDS = 8;
    var console = getConsole();

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
                console.log('Attempt to subscribe to publication ' + publicationName + ' failed');
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
            console.log('Syncing with subscription [name:' + subNotification.name + ', id:' + subNotification.subscriptionId + ' , params:' + JSON.stringify(subNotification.params) + ']. Records:' + subNotification.records.length + '[' + (subNotification.diff ? 'Diff' : 'All') + ']');
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
        var subscriptionId, maxRevision = 0, timestampField, isSyncingOn = false, isSingle, updateDataStorage, cache, isInitialPushCompleted, deferredInitialization;
        var onReadyOff, formatRecord;
        var reconnectOff, publicationListenerOff, destroyOff;
        var objectClass;

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
            maxRevision = 0;
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

            isSingle = value;
            if (value) {
                updateDataStorage = updateSyncedObject;
                cache = objectClass ? new objectClass({}) : {};
            } else {
                updateDataStorage = updateSyncedArray;
                cache = [];
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
            console.log('Sync ' + publication + ' on. Params:' + JSON.stringify(subParams));
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

                console.log('Sync ' + publication + ' off. Params:' + JSON.stringify(subParams));
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
                    console.debug('Resyncing after network loss to ' + publication);
                    // note the backend might return a new subscription if the client took too much time to reconnect.
                    registerSubscription();
                });
            }, listenNow ? 0 : 2000);
        }

        function registerSubscription() {
            $socketio.fetch('sync.subscribe', {
                id: subscriptionId, // to try to re-use existing subcription
                publication: publication,
                params: subParams
            }).then(function (subId) {
                subscriptionId = subId;
            });
        }

        function unregisterSubscription() {
            if (subscriptionId) {
                $socketio.fetch('sync.unsubscribe', subscriptionId);
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
                //                   console.log('Datasync [' + dataStreamName + '] received:' +JSON.stringify(record));//+ record.id);
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
            console.debug('Sync -> Inserted New record #' + record.id + ' for subscription to ' + publication);// JSON.stringify(record));
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
            console.debug('Sync -> Updated record #' + record.id + ' for subscription to ' + publication);// JSON.stringify(record));
            updateDataStorage(formatRecord ? formatRecord(record) : record);
            syncListener.notify('update', record);
            return record;
        }


        function removeRecord(record) {
            var previous = recordStates[record.id];
            if (!previous || getRevision(record) > getRevision(previous)) {
                console.debug('Sync -> Removed #' + record.id + ' for subscription to ' + publication);
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
                    //console.debug('Collect Now:' + JSON.stringify(record));
                    delete recordStates[record.id];
                }
            });
        }

        function isExistingStateFor(recordId) {
            return !!recordStates[recordId];
        }

        function updateSyncedObject(record) {
            recordStates[record.id] = record;
            clearObject(cache);
            if (!record.remove) {
                angular.extend(cache, record);
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
                // update the instance
                clearObject(existing);
                angular.extend(existing, record);
                if (record.removed) {
                    cache.splice(cache.indexOf(existing), 1);
                }
            }
        }

        function clearObject(object) {
            Object.keys(object).forEach(function (key) { delete object[key]; });
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
    function getConsole() {
        // to help with debugging for now until we opt for a nice logger. In production, log and debug should automatically be removed by the build from the code.... TODO:need to check out the production code
        return {
            log: function (msg) {
                window.console.debug('SYNC(info): ' + msg);
            },
            debug: function (msg) {
                //  window.console.debug('SYNC(debug): ' + msg);
            }
        };
    }
};
