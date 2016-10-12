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
sync.$inject = ["$rootScope", "$q", "$socketio", "$syncGarbageCollector"];
angular
    .module('sync')
    .factory('$sync', sync);

function sync($rootScope, $q, $socketio, $syncGarbageCollector) {
    var publicationListeners = {},
        publicationListenerCount = 0;
    var GRACE_PERIOD_IN_SECONDS = 8;
    var SYNC_VERSION = '1.0';
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
}());


//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImFuZ3VsYXItc3luYy5qcyIsIi9zb3VyY2Uvc3luYy5tb2R1bGUuanMiLCIvc291cmNlL3NlcnZpY2VzL3N5bmMtZ2FyYmFnZS1jb2xsZWN0b3Iuc2VydmljZS5qcyIsIi9zb3VyY2Uvc2VydmljZXMvc3luYy5zZXJ2aWNlLmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLENBQUMsV0FBVztBQUNaOztBQ0RBO0tBQ0EsT0FBQSxRQUFBLENBQUE7S0FDQSw2QkFBQSxTQUFBLGtCQUFBO1FBQ0Esa0JBQUEsU0FBQTs7OztBRE9BLENBQUMsV0FBVztBQUNaOztBRVhBO0tBQ0EsT0FBQTtLQUNBLFFBQUEseUJBQUE7Ozs7Ozs7Ozs7QUFVQSxTQUFBLHVCQUFBO0lBQ0EsSUFBQSxRQUFBO0lBQ0EsSUFBQSxVQUFBO0lBQ0EsSUFBQSxZQUFBOztJQUVBLElBQUEsVUFBQTtRQUNBLFlBQUE7UUFDQSxZQUFBO1FBQ0EsU0FBQTtRQUNBLFVBQUE7UUFDQSxLQUFBO1FBQ0EsY0FBQTs7O0lBR0EsT0FBQTs7OztJQUlBLFNBQUEsV0FBQSxPQUFBO1FBQ0EsVUFBQTs7O0lBR0EsU0FBQSxhQUFBO1FBQ0EsT0FBQTs7O0lBR0EsU0FBQSxlQUFBO1FBQ0EsT0FBQSxNQUFBOzs7SUFHQSxTQUFBLFFBQUEsU0FBQTtRQUNBLE1BQUEsS0FBQTtZQUNBLFdBQUEsS0FBQTtZQUNBLFNBQUE7O1FBRUEsSUFBQSxDQUFBLFdBQUE7WUFDQSxRQUFBOzs7O0lBSUEsU0FBQSxXQUFBO1FBQ0EsSUFBQSxDQUFBLFNBQUE7WUFDQSxRQUFBO1lBQ0E7O1FBRUEsWUFBQTtRQUNBLFdBQUEsWUFBQTtZQUNBLFFBQUE7WUFDQSxJQUFBLE1BQUEsU0FBQSxHQUFBO2dCQUNBO21CQUNBO2dCQUNBLFlBQUE7O1dBRUEsVUFBQTs7O0lBR0EsU0FBQSxNQUFBO1FBQ0EsSUFBQSxVQUFBLEtBQUEsUUFBQSxVQUFBO1FBQ0EsT0FBQSxNQUFBLFNBQUEsS0FBQSxNQUFBLEdBQUEsYUFBQSxTQUFB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Q0FBQSxNQUFBLE1BQUE7O3dCQUVBLGVBQUE7d0JBQ0EsSUFBQSxDQUFBLFVBQUE7NEJBQ0EsTUFBQSxTQUFBOzs7b0JBR0EsYUFBQSxNQUFBO29CQUNBLElBQUEsQ0FBQSx3QkFBQTt3QkFDQSx5QkFBQTt3QkFDQSx1QkFBQSxRQUFBOzs7Ozs7Ozs7UUFTQSxTQUFBLHdDQUFBLGFBQUE7Ozs7WUFJQSxJQUFBLENBQUEsYUFBQSxPQUFBLEtBQUEsV0FBQSxVQUFBLEdBQUE7Z0JBQ0EsT0FBQTs7WUFFQSxJQUFBLFdBQUE7WUFDQSxLQUFBLElBQUEsU0FBQSxhQUFBOzs7Z0JBR0EsSUFBQSxZQUFBLFdBQUEsVUFBQSxRQUFBO29CQUNBOzs7WUFHQSxPQUFBOzs7OztRQUtBLFNBQUEsYUFBQSxTQUFBO1lBQ0EsSUFBQSxlQUFBO1lBQ0EsSUFBQTtZQUNBLElBQUEsUUFBQTtZQUNBLFFBQUEsUUFBQSxVQUFBLFFBQUE7O2dCQUVBLElBQUEsT0FBQSxRQUFBO29CQUNBLGFBQUE7dUJBQ0EsSUFBQSxhQUFBLE9BQUEsS0FBQTs7b0JBRUEsVUFBQSxhQUFBO3VCQUNBO29CQUNBLFVBQUEsVUFBQTs7Z0JBRUEsSUFBQSxTQUFBO29CQUNBLGFBQUEsS0FBQTs7O1lBR0EsSUFBQSxRQUFBO1lBQ0EsSUFBQSxVQUFBO2dCQUNBLGFBQUEsT0FBQSxTQUFBO21CQUNBO2dCQUNBLGFBQUEsT0FBQSxTQUFBLFdBQUE7Ozs7Ozs7OztRQVNBLFNBQUEsVUFBQTtZQUNBLE9BQUEsS0FBQTs7Ozs7O1FBTUEsU0FBQSxNQUFBLFVBQUE7WUFDQSxPQUFBLGFBQUEsR0FBQSxPQUFBOzs7Ozs7O1FBT0EsU0FBQSxTQUFBLFVBQUE7WUFDQSxPQUFBLGFBQUEsR0FBQSxVQUFBOzs7Ozs7O1FBT0EsU0FBQSxTQUFBLFVBQUE7WUFDQSxPQUFBLGFBQUEsR0FBQSxVQUFBOzs7Ozs7O1FBT0EsU0FBQSxRQUFBLFVBQUE7WUFDQSxPQUFBLGFBQUEsR0FBQSxTQUFBOzs7O1FBSUEsU0FBQSxVQUFBLFFBQUE7WUFDQSxRQUFBLE1BQUEsa0NBQUEsT0FBQSxLQUFBLDBCQUFBO1lBQ0EsWUFBQTtZQUNBLGtCQUFBLGVBQUEsYUFBQSxVQUFBO1lBQ0EsYUFBQSxPQUFBLE9BQUE7WUFDQSxPQUFBOzs7UUFHQSxTQUFBLGFBQUEsUUFBQTtZQUNBLElBQUEsV0FBQSxhQUFBLE9BQUE7WUFDQSxJQUFBLFlBQUEsV0FBQSxZQUFBLFdBQUE7Z0JBQ0EsT0FBQTs7WUFFQSxRQUFBLE1BQUEsNkJBQUEsT0FBQSxLQUFBLDBCQUFBO1lBQ0Esa0JBQUEsZUFBQSxhQUFBLFVBQUE7WUFDQSxhQUFBLE9BQUEsVUFBQTtZQUNBLE9BQUE7Ozs7UUFJQSxTQUFBLGFBQUEsUUFBQTtZQUNBLElBQUEsV0FBQSxhQUFBLE9BQUE7WUFDQSxJQUFBLENBQUEsWUFBQSxZQUFBLFVBQUEsWUFBQSxXQUFBO2dCQUNBLFFBQUEsTUFBQSxzQkFBQSxPQUFBLEtBQUEsMEJBQUE7OztnQkFHQSxPQUFBLFVBQUE7Z0JBQ0Esa0JBQUE7O2dCQUVBLElBQUEsVUFBQTtvQkFDQSxhQUFBLE9BQUEsVUFBQTtvQkFDQSxRQUFBOzs7O1FBSUEsU0FBQSxRQUFBLFFBQUE7WUFDQSxzQkFBQSxRQUFBLFNBQUEsVUFBQTtnQkFDQSxJQUFBLGlCQUFBLGFBQUEsT0FBQTtnQkFDQSxJQUFBLGtCQUFBLE9BQUEsWUFBQSxlQUFBO2tCQUNBOztvQkFFQSxPQUFBLGFBQUEsT0FBQTs7Ozs7UUFLQSxTQUFBLG1CQUFBLFVBQUE7WUFDQSxPQUFBLENBQUEsQ0FBQSxhQUFBOzs7UUFHQSxTQUFBLG1CQUFBLFFBQUE7WUFDQSxhQUFBLE9BQUEsTUFBQTtZQUNBLFlBQUE7WUFDQSxJQUFBLENBQUEsT0FBQSxRQUFBO2dCQUNBLFFBQUEsT0FBQSxPQUFBOzs7O1FBSUEsU0FBQSxrQkFBQSxRQUFBO1lBQ0EsSUFBQSxXQUFBLGFBQUEsT0FBQTtZQUNBLElBQUEsQ0FBQSxVQUFBOztnQkFFQSxhQUFBLE9BQUEsTUFBQTtnQkFDQSxJQUFBLENBQUEsT0FBQSxTQUFBO29CQUNBLE1BQUEsS0FBQTs7bUJBRUE7O2dCQUVBLFlBQUE7Z0JBQ0EsUUFBQSxPQUFBLFVBQUE7Z0JBQ0EsSUFBQSxPQUFBLFNBQUE7b0JBQ0EsTUFBQSxPQUFBLE1BQUEsUUFBQSxXQUFBOzs7OztRQUtBLFNBQUEsWUFBQSxRQUFBO1lBQ0EsT0FBQSxLQUFBLFFBQUEsUUFBQSxVQUFBLEtBQUEsRUFBQSxPQUFBLE9BQUE7OztRQUdBLFNBQUEsWUFBQSxRQUFBOztZQUVBLElBQUEsUUFBQSxVQUFBLE9BQUEsV0FBQTtnQkFDQSxPQUFBLE9BQUE7O1lBRUEsSUFBQSxRQUFBLFVBQUEsT0FBQSxZQUFBO2dCQUNBLE9BQUEsT0FBQTs7WUFFQSxNQUFBLElBQUEsTUFBQSxpRUFBQSxjQUFBLGFBQUEsWUFBQSxPQUFBLE1BQUE7Ozs7Ozs7SUFPQSxTQUFBLGVBQUE7UUFDQSxJQUFBLFNBQUE7UUFDQSxJQUFBLFFBQUE7O1FBRUEsS0FBQSxTQUFBO1FBQ0EsS0FBQSxLQUFBOztRQUVBLFNBQUEsT0FBQSxPQUFBLE9BQUEsT0FBQTtZQUNBLElBQUEsWUFBQSxPQUFBO1lBQ0EsSUFBQSxXQUFBO2dCQUNBLEVBQUEsUUFBQSxXQUFBLFVBQUEsVUFBQSxJQUFBO29CQUNBLFNBQUEsT0FBQTs7Ozs7Ozs7UUFRQSxTQUFBLEdBQUEsT0FBQSxVQUFBO1lBQ0EsSUFBQSxZQUFBLE9BQUE7WUFDQSxJQUFBLENBQUEsV0FBQTtnQkFDQSxZQUFBLE9BQUEsU0FBQTs7WUFFQSxJQUFBLEtBQUE7WUFDQSxVQUFBLFFBQUE7WUFDQSxPQUFBLFlBQUE7Z0JBQ0EsT0FBQSxVQUFBOzs7O0lBSUEsU0FBQSxhQUFBOztRQUVBLE9BQUE7WUFDQSxLQUFBLFVBQUEsS0FBQTtnQkFDQSxPQUFBLFFBQUEsTUFBQSxpQkFBQTs7WUFFQSxPQUFBLFVBQUEsS0FBQTs7Ozs7Q0FLQTs7O0FIK0ZBIiwiZmlsZSI6ImFuZ3VsYXItc3luYy5qcyIsInNvdXJjZXNDb250ZW50IjpbIihmdW5jdGlvbigpIHtcblwidXNlIHN0cmljdFwiO1xuXG5hbmd1bGFyXG4gICAgLm1vZHVsZSgnc3luYycsIFsnc29ja2V0aW8tYXV0aCddKVxuICAgIC5jb25maWcoZnVuY3Rpb24oJHNvY2tldGlvUHJvdmlkZXIpe1xuICAgICAgICAkc29ja2V0aW9Qcm92aWRlci5zZXREZWJ1Zyh0cnVlKTtcbiAgICB9KTtcbn0oKSk7XG5cbihmdW5jdGlvbigpIHtcblwidXNlIHN0cmljdFwiO1xuXG5hbmd1bGFyXG4gICAgLm1vZHVsZSgnc3luYycpXG4gICAgLmZhY3RvcnkoJyRzeW5jR2FyYmFnZUNvbGxlY3RvcicsIHN5bmNHYXJiYWdlQ29sbGVjdG9yKTtcblxuLyoqXG4gKiBzYWZlbHkgcmVtb3ZlIGRlbGV0ZWQgcmVjb3JkL29iamVjdCBmcm9tIG1lbW9yeSBhZnRlciB0aGUgc3luYyBwcm9jZXNzIGRpc3Bvc2VkIHRoZW0uXG4gKiBcbiAqIFRPRE86IFNlY29uZHMgc2hvdWxkIHJlZmxlY3QgdGhlIG1heCB0aW1lICB0aGF0IHN5bmMgY2FjaGUgaXMgdmFsaWQgKG5ldHdvcmsgbG9zcyB3b3VsZCBmb3JjZSBhIHJlc3luYyksIHdoaWNoIHNob3VsZCBtYXRjaCBtYXhEaXNjb25uZWN0aW9uVGltZUJlZm9yZURyb3BwaW5nU3Vic2NyaXB0aW9uIG9uIHRoZSBzZXJ2ZXIgc2lkZS5cbiAqIFxuICogTm90ZTpcbiAqIHJlbW92ZWQgcmVjb3JkIHNob3VsZCBiZSBkZWxldGVkIGZyb20gdGhlIHN5bmMgaW50ZXJuYWwgY2FjaGUgYWZ0ZXIgYSB3aGlsZSBzbyB0aGF0IHRoZXkgZG8gbm90IHN0YXkgaW4gdGhlIG1lbW9yeS4gVGhleSBjYW5ub3QgYmUgcmVtb3ZlZCB0b28gZWFybHkgYXMgYW4gb2xkZXIgdmVyc2lvbi9zdGFtcCBvZiB0aGUgcmVjb3JkIGNvdWxkIGJlIHJlY2VpdmVkIGFmdGVyIGl0cyByZW1vdmFsLi4ud2hpY2ggd291bGQgcmUtYWRkIHRvIGNhY2hlLi4uZHVlIGFzeW5jaHJvbm91cyBwcm9jZXNzaW5nLi4uXG4gKi9cbmZ1bmN0aW9uIHN5bmNHYXJiYWdlQ29sbGVjdG9yKCkge1xuICAgIHZhciBpdGVtcyA9IFtdO1xuICAgIHZhciBzZWNvbmRzID0gMjtcbiAgICB2YXIgc2NoZWR1bGVkID0gZmFsc2U7XG5cbiAgICB2YXIgc2VydmljZSA9IHtcbiAgICAgICAgc2V0U2Vjb25kczogc2V0U2Vjb25kcyxcbiAgICAgICAgZ2V0U2Vjb25kczogZ2V0U2Vjb25kcyxcbiAgICAgICAgZGlzcG9zZTogZGlzcG9zZSxcbiAgICAgICAgc2NoZWR1bGU6IHNjaGVkdWxlLFxuICAgICAgICBydW46IHJ1bixcbiAgICAgICAgZ2V0SXRlbUNvdW50OiBnZXRJdGVtQ291bnRcbiAgICB9O1xuXG4gICAgcmV0dXJuIHNlcnZpY2U7XG5cbiAgICAvLy8vLy8vLy8vXG5cbiAgICBmdW5jdGlvbiBzZXRTZWNvbmRzKHZhbHVlKSB7XG4gICAgICAgIHNlY29uZHMgPSB2YWx1ZTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBnZXRTZWNvbmRzKCkge1xuICAgICAgICByZXR1cm4gc2Vjb25kcztcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBnZXRJdGVtQ291bnQoKSB7XG4gICAgICAgIHJldHVybiBpdGVtcy5sZW5ndGg7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gZGlzcG9zZShjb2xsZWN0KSB7XG4gICAgICAgIGl0ZW1zLnB1c2goe1xuICAgICAgICAgICAgdGltZXN0YW1wOiBEYXRlLm5vdygpLFxuICAgICAgICAgICAgY29sbGVjdDogY29sbGVjdFxuICAgICAgICB9KTtcbiAgICAgICAgaWYgKCFzY2hlZHVsZWQpIHtcbiAgICAgICAgICAgIHNlcnZpY2Uuc2NoZWR1bGUoKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGZ1bmN0aW9uIHNjaGVkdWxlKCkge1xuICAgICAgICBpZiAoIXNlY29uZHMpIHtcbiAgICAgICAgICAgIHNlcnZpY2UucnVuKCk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgc2NoZWR1bGVkID0gdHJ1ZTtcbiAgICAgICAgc2V0VGltZW91dChmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICBzZXJ2aWNlLnJ1bigpO1xuICAgICAgICAgICAgaWYgKGl0ZW1zLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgICAgICBzY2hlZHVsZSgpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBzY2hlZHVsZWQgPSBmYWxzZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSwgc2Vjb25kcyAqIDEwMDApO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIHJ1bigpIHtcbiAgICAgICAgdmFyIHRpbWVvdXQgPSBEYXRlLm5vdygpIC0gc2Vjb25kcyAqIDEwMDA7XG4gICAgICAgIHdoaWxlIChpdGVtcy5sZW5ndGggPiAwICYmIGl0ZW1zWzBdLnRpbWVzdGFtcCA8PSB0aW1lb3V0KSB7XG4gICAgICAgICAgICBpdGVtcy5zaGlmdCgpLmNvbGxlY3QoKTtcbiAgICAgICAgfVxuICAgIH1cbn1cbn0oKSk7XG5cbihmdW5jdGlvbigpIHtcblwidXNlIHN0cmljdFwiO1xuXG4vKipcbiAqIFxuICogU2VydmljZSB0aGF0IGFsbG93cyBhbiBhcnJheSBvZiBkYXRhIHJlbWFpbiBpbiBzeW5jIHdpdGggYmFja2VuZC5cbiAqIFxuICogXG4gKiBleDpcbiAqIHdoZW4gdGhlcmUgaXMgYSBub3RpZmljYXRpb24sIG5vdGljYXRpb25TZXJ2aWNlIG5vdGlmaWVzIHRoYXQgdGhlcmUgaXMgc29tZXRoaW5nIG5ldy4uLnRoZW4gdGhlIGRhdGFzZXQgZ2V0IHRoZSBkYXRhIGFuZCBub3RpZmllcyBhbGwgaXRzIGNhbGxiYWNrLlxuICogXG4gKiBOT1RFOiBcbiAqICBcbiAqIFxuICogUHJlLVJlcXVpc3RlOlxuICogLS0tLS0tLS0tLS0tLVxuICogU3luYyBkb2VzIG5vdCB3b3JrIGlmIG9iamVjdHMgZG8gbm90IGhhdmUgQk9USCBpZCBhbmQgcmV2aXNpb24gZmllbGQhISEhXG4gKiBcbiAqIFdoZW4gdGhlIGJhY2tlbmQgd3JpdGVzIGFueSBkYXRhIHRvIHRoZSBkYiB0aGF0IGFyZSBzdXBwb3NlZCB0byBiZSBzeW5jcm9uaXplZDpcbiAqIEl0IG11c3QgbWFrZSBzdXJlIGVhY2ggYWRkLCB1cGRhdGUsIHJlbW92YWwgb2YgcmVjb3JkIGlzIHRpbWVzdGFtcGVkLlxuICogSXQgbXVzdCBub3RpZnkgdGhlIGRhdGFzdHJlYW0gKHdpdGggbm90aWZ5Q2hhbmdlIG9yIG5vdGlmeVJlbW92YWwpIHdpdGggc29tZSBwYXJhbXMgc28gdGhhdCBiYWNrZW5kIGtub3dzIHRoYXQgaXQgaGFzIHRvIHB1c2ggYmFjayB0aGUgZGF0YSBiYWNrIHRvIHRoZSBzdWJzY3JpYmVycyAoZXg6IHRoZSB0YXNrQ3JlYXRpb24gd291bGQgbm90aWZ5IHdpdGggaXRzIHBsYW5JZClcbiogXG4gKiBcbiAqL1xuYW5ndWxhclxuICAgIC5tb2R1bGUoJ3N5bmMnKVxuICAgIC5mYWN0b3J5KCckc3luYycsIHN5bmMpO1xuXG5mdW5jdGlvbiBzeW5jKCRyb290U2NvcGUsICRxLCAkc29ja2V0aW8sICRzeW5jR2FyYmFnZUNvbGxlY3Rvcikge1xuICAgIHZhciBwdWJsaWNhdGlvbkxpc3RlbmVycyA9IHt9LFxuICAgICAgICBwdWJsaWNhdGlvbkxpc3RlbmVyQ291bnQgPSAwO1xuICAgIHZhciBHUkFDRV9QRVJJT0RfSU5fU0VDT05EUyA9IDg7XG4gICAgdmFyIFNZTkNfVkVSU0lPTiA9ICcxLjAnO1xuICAgIHZhciBjb25zb2xlID0gZ2V0Q29uc29sZSgpO1xuXG4gICAgbGlzdGVuVG9TeW5jTm90aWZpY2F0aW9uKCk7XG5cbiAgICB2YXIgc2VydmljZSA9IHtcbiAgICAgICAgc3Vic2NyaWJlOiBzdWJzY3JpYmUsXG4gICAgICAgIHJlc29sdmVTdWJzY3JpcHRpb246IHJlc29sdmVTdWJzY3JpcHRpb24sXG4gICAgICAgIGdldEdyYWNlUGVyaW9kOiBnZXRHcmFjZVBlcmlvZFxuICAgIH07XG5cbiAgICByZXR1cm4gc2VydmljZTtcblxuICAgIC8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vXG4gICAgLyoqXG4gICAgICogc3Vic2NyaWJlIHRvIHB1YmxpY2F0aW9uIGFuZCByZXR1cm5zIHRoZSBzdWJzY3JpcHRpb24gd2hlbiBkYXRhIGlzIGF2YWlsYWJsZS4gXG4gICAgICogQHBhcmFtIHB1YmxpY2F0aW9uIG5hbWUuIG9uIHRoZSBzZXJ2ZXIgc2lkZSwgYSBwdWJsaWNhdGlvbiBzaGFsbCBleGlzdC4gZXg6IG1hZ2F6aW5lcy5zeW5jXG4gICAgICogQHBhcmFtIHBhcmFtcyAgIHRoZSBwYXJhbXMgb2JqZWN0IHBhc3NlZCB0byB0aGUgc3Vic2NyaXB0aW9uLCBleDoge21hZ2F6aW5lSWQ6J2VudHJlcHJlbmV1cid9KVxuICAgICAqIEBwYXJhbSBvYmplY3RDbGFzcyBhbiBpbnN0YW5jZSBvZiB0aGlzIGNsYXNzIHdpbGwgYmUgY3JlYXRlZCBmb3IgZWFjaCByZWNvcmQgcmVjZWl2ZWQuXG4gICAgICogcmV0dXJucyBhIHByb21pc2UgcmV0dXJuaW5nIHRoZSBzdWJzY3JpcHRpb24gd2hlbiB0aGUgZGF0YSBpcyBzeW5jZWRcbiAgICAgKiBvciByZWplY3RzIGlmIHRoZSBpbml0aWFsIHN5bmMgZmFpbHMgdG8gY29tcGxldGUgaW4gYSBsaW1pdGVkIGFtb3VudCBvZiB0aW1lLiBcbiAgICAgKiBcbiAgICAgKiB0byBnZXQgdGhlIGRhdGEgZnJvbSB0aGUgZGF0YVNldCwganVzdCBkYXRhU2V0LmdldERhdGEoKVxuICAgICAqL1xuICAgIGZ1bmN0aW9uIHJlc29sdmVTdWJzY3JpcHRpb24ocHVibGljYXRpb25OYW1lLCBwYXJhbXMsIG9iamVjdENsYXNzKSB7XG4gICAgICAgIHZhciBkZWZlcnJlZCA9ICRxLmRlZmVyKCk7XG4gICAgICAgIHZhciBzRHMgPSBzdWJzY3JpYmUocHVibGljYXRpb25OYW1lKS5zZXRPYmplY3RDbGFzcyhvYmplY3RDbGFzcyk7XG5cbiAgICAgICAgLy8gZ2l2ZSBhIGxpdHRsZSB0aW1lIGZvciBzdWJzY3JpcHRpb24gdG8gZmV0Y2ggdGhlIGRhdGEuLi5vdGhlcndpc2UgZ2l2ZSB1cCBzbyB0aGF0IHdlIGRvbid0IGdldCBzdHVjayBpbiBhIHJlc29sdmUgd2FpdGluZyBmb3JldmVyLlxuICAgICAgICB2YXIgZ3JhY2VQZXJpb2QgPSBzZXRUaW1lb3V0KGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIGlmICghc0RzLnJlYWR5KSB7XG4gICAgICAgICAgICAgICAgc0RzLmRlc3Ryb3koKTtcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZygnQXR0ZW1wdCB0byBzdWJzY3JpYmUgdG8gcHVibGljYXRpb24gJyArIHB1YmxpY2F0aW9uTmFtZSArICcgZmFpbGVkJyk7XG4gICAgICAgICAgICAgICAgZGVmZXJyZWQucmVqZWN0KCdTWU5DX1RJTUVPVVQnKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSwgR1JBQ0VfUEVSSU9EX0lOX1NFQ09ORFMgKiAxMDAwKTtcblxuICAgICAgICBzRHMuc2V0UGFyYW1ldGVycyhwYXJhbXMpXG4gICAgICAgICAgICAud2FpdEZvckRhdGFSZWFkeSgpXG4gICAgICAgICAgICAudGhlbihmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgY2xlYXJUaW1lb3V0KGdyYWNlUGVyaW9kKTtcbiAgICAgICAgICAgICAgICBkZWZlcnJlZC5yZXNvbHZlKHNEcyk7XG4gICAgICAgICAgICB9KS5jYXRjaChmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgY2xlYXJUaW1lb3V0KGdyYWNlUGVyaW9kKTtcbiAgICAgICAgICAgICAgICBzRHMuZGVzdHJveSgpO1xuICAgICAgICAgICAgICAgIGRlZmVycmVkLnJlamVjdCgnRmFpbGVkIHRvIHN1YnNjcmliZSB0byBwdWJsaWNhdGlvbiAnICsgcHVibGljYXRpb25OYW1lICsgJyBmYWlsZWQnKTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICByZXR1cm4gZGVmZXJyZWQucHJvbWlzZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBcbiAgICAgKiBmb3IgdGVzdCBwdXJwb3NlcywgcmV0dXJucyB0aGUgdGltZSByZXNvbHZlU3Vic2NyaXB0aW9uIGJlZm9yZSBpdCB0aW1lcyBvdXQuXG4gICAgICovXG4gICAgZnVuY3Rpb24gZ2V0R3JhY2VQZXJpb2QoKSB7XG4gICAgICAgIHJldHVybiBHUkFDRV9QRVJJT0RfSU5fU0VDT05EUztcbiAgICB9XG4gICAgLyoqXG4gICAgICogc3Vic2NyaWJlIHRvIHB1YmxpY2F0aW9uLiBJdCB3aWxsIG5vdCBzeW5jIHVudGlsIHlvdSBzZXQgdGhlIHBhcmFtcy5cbiAgICAgKiBcbiAgICAgKiBAcGFyYW0gcHVibGljYXRpb24gbmFtZS4gb24gdGhlIHNlcnZlciBzaWRlLCBhIHB1YmxpY2F0aW9uIHNoYWxsIGV4aXN0LiBleDogbWFnYXppbmVzLnN5bmNcbiAgICAgKiBAcGFyYW0gcGFyYW1zICAgdGhlIHBhcmFtcyBvYmplY3QgcGFzc2VkIHRvIHRoZSBzdWJzY3JpcHRpb24sIGV4OiB7bWFnYXppbmVJZDonZW50cmVwcmVuZXVyJ30pXG4gICAgICogcmV0dXJucyBzdWJzY3JpcHRpb25cbiAgICAgKiBcbiAgICAgKi9cbiAgICBmdW5jdGlvbiBzdWJzY3JpYmUocHVibGljYXRpb25OYW1lLCBzY29wZSkge1xuICAgICAgICByZXR1cm4gbmV3IFN1YnNjcmlwdGlvbihwdWJsaWNhdGlvbk5hbWUsIHNjb3BlKTtcbiAgICB9XG5cblxuXG4gICAgLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy9cbiAgICAvLyBIRUxQRVJTXG5cbiAgICAvLyBldmVyeSBzeW5jIG5vdGlmaWNhdGlvbiBjb21lcyB0aHJ1IHRoZSBzYW1lIGV2ZW50IHRoZW4gaXQgaXMgZGlzcGF0Y2hlcyB0byB0aGUgdGFyZ2V0ZWQgc3Vic2NyaXB0aW9ucy5cbiAgICBmdW5jdGlvbiBsaXN0ZW5Ub1N5bmNOb3RpZmljYXRpb24oKSB7XG4gICAgICAgICRzb2NrZXRpby5vbignU1lOQ19OT1cnLCBmdW5jdGlvbiAoc3ViTm90aWZpY2F0aW9uLCBmbikge1xuICAgICAgICAgICAgY29uc29sZS5sb2coJ1N5bmNpbmcgd2l0aCBzdWJzY3JpcHRpb24gW25hbWU6JyArIHN1Yk5vdGlmaWNhdGlvbi5uYW1lICsgJywgaWQ6JyArIHN1Yk5vdGlmaWNhdGlvbi5zdWJzY3JpcHRpb25JZCArICcgLCBwYXJhbXM6JyArIEpTT04uc3RyaW5naWZ5KHN1Yk5vdGlmaWNhdGlvbi5wYXJhbXMpICsgJ10uIFJlY29yZHM6JyArIHN1Yk5vdGlmaWNhdGlvbi5yZWNvcmRzLmxlbmd0aCArICdbJyArIChzdWJOb3RpZmljYXRpb24uZGlmZiA/ICdEaWZmJyA6ICdBbGwnKSArICddJyk7XG4gICAgICAgICAgICB2YXIgbGlzdGVuZXJzID0gcHVibGljYXRpb25MaXN0ZW5lcnNbc3ViTm90aWZpY2F0aW9uLm5hbWVdO1xuICAgICAgICAgICAgaWYgKGxpc3RlbmVycykge1xuICAgICAgICAgICAgICAgIGZvciAodmFyIGxpc3RlbmVyIGluIGxpc3RlbmVycykge1xuICAgICAgICAgICAgICAgICAgICBsaXN0ZW5lcnNbbGlzdGVuZXJdKHN1Yk5vdGlmaWNhdGlvbik7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgZm4oJ1NZTkNFRCcpOyAvLyBsZXQga25vdyB0aGUgYmFja2VuZCB0aGUgY2xpZW50IHdhcyBhYmxlIHRvIHN5bmMuXG4gICAgICAgIH0pO1xuICAgIH07XG5cblxuICAgIC8vIHRoaXMgYWxsb3dzIGEgZGF0YXNldCB0byBsaXN0ZW4gdG8gYW55IFNZTkNfTk9XIGV2ZW50Li5hbmQgaWYgdGhlIG5vdGlmaWNhdGlvbiBpcyBhYm91dCBpdHMgZGF0YS5cbiAgICBmdW5jdGlvbiBhZGRQdWJsaWNhdGlvbkxpc3RlbmVyKHN0cmVhbU5hbWUsIGNhbGxiYWNrKSB7XG4gICAgICAgIHZhciB1aWQgPSBwdWJsaWNhdGlvbkxpc3RlbmVyQ291bnQrKztcbiAgICAgICAgdmFyIGxpc3RlbmVycyA9IHB1YmxpY2F0aW9uTGlzdGVuZXJzW3N0cmVhbU5hbWVdO1xuICAgICAgICBpZiAoIWxpc3RlbmVycykge1xuICAgICAgICAgICAgcHVibGljYXRpb25MaXN0ZW5lcnNbc3RyZWFtTmFtZV0gPSBsaXN0ZW5lcnMgPSB7fTtcbiAgICAgICAgfVxuICAgICAgICBsaXN0ZW5lcnNbdWlkXSA9IGNhbGxiYWNrO1xuXG4gICAgICAgIHJldHVybiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICBkZWxldGUgbGlzdGVuZXJzW3VpZF07XG4gICAgICAgIH1cbiAgICB9XG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gICAgLy8gU3Vic2NyaXB0aW9uIG9iamVjdFxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgIC8qKlxuICAgICAqIGEgc3Vic2NyaXB0aW9uIHN5bmNocm9uaXplcyB3aXRoIHRoZSBiYWNrZW5kIGZvciBhbnkgYmFja2VuZCBkYXRhIGNoYW5nZSBhbmQgbWFrZXMgdGhhdCBkYXRhIGF2YWlsYWJsZSB0byBhIGNvbnRyb2xsZXIuXG4gICAgICogXG4gICAgICogIFdoZW4gY2xpZW50IHN1YnNjcmliZXMgdG8gYW4gc3luY3Jvbml6ZWQgYXBpLCBhbnkgZGF0YSBjaGFuZ2UgdGhhdCBpbXBhY3RzIHRoZSBhcGkgcmVzdWx0IFdJTEwgYmUgUFVTSGVkIHRvIHRoZSBjbGllbnQuXG4gICAgICogSWYgdGhlIGNsaWVudCBkb2VzIE5PVCBzdWJzY3JpYmUgb3Igc3RvcCBzdWJzY3JpYmUsIGl0IHdpbGwgbm8gbG9uZ2VyIHJlY2VpdmUgdGhlIFBVU0guIFxuICAgICAqICAgIFxuICAgICAqIGlmIHRoZSBjb25uZWN0aW9uIGlzIGxvc3QgZm9yIGEgc2hvcnQgdGltZSAoZHVyYXRpb24gZGVmaW5lZCBvbiBzZXJ2ZXItc2lkZSksIHRoZSBzZXJ2ZXIgcXVldWVzIHRoZSBjaGFuZ2VzIGlmIGFueS4gXG4gICAgICogV2hlbiB0aGUgY29ubmVjdGlvbiByZXR1cm5zLCB0aGUgbWlzc2luZyBkYXRhIGF1dG9tYXRpY2FsbHkgIHdpbGwgYmUgUFVTSGVkIHRvIHRoZSBzdWJzY3JpYmluZyBjbGllbnQuXG4gICAgICogaWYgdGhlIGNvbm5lY3Rpb24gaXMgbG9zdCBmb3IgYSBsb25nIHRpbWUgKGR1cmF0aW9uIGRlZmluZWQgb24gdGhlIHNlcnZlciksIHRoZSBzZXJ2ZXIgd2lsbCBkZXN0cm95IHRoZSBzdWJzY3JpcHRpb24uIFRvIHNpbXBsaWZ5LCB0aGUgY2xpZW50IHdpbGwgcmVzdWJzY3JpYmUgYXQgaXRzIHJlY29ubmVjdGlvbiBhbmQgZ2V0IGFsbCBkYXRhLlxuICAgICAqIFxuICAgICAqIHN1YnNjcmlwdGlvbiBvYmplY3QgcHJvdmlkZXMgMyBjYWxsYmFja3MgKGFkZCx1cGRhdGUsIGRlbCkgd2hpY2ggYXJlIGNhbGxlZCBkdXJpbmcgc3luY2hyb25pemF0aW9uLlxuICAgICAqICAgICAgXG4gICAgICogU2NvcGUgd2lsbCBhbGxvdyB0aGUgc3Vic2NyaXB0aW9uIHN0b3Agc3luY2hyb25pemluZyBhbmQgY2FuY2VsIHJlZ2lzdHJhdGlvbiB3aGVuIGl0IGlzIGRlc3Ryb3llZC4gXG4gICAgICogIFxuICAgICAqIENvbnN0cnVjdG9yOlxuICAgICAqIFxuICAgICAqIEBwYXJhbSBwdWJsaWNhdGlvbiwgdGhlIHB1YmxpY2F0aW9uIG11c3QgZXhpc3Qgb24gdGhlIHNlcnZlciBzaWRlXG4gICAgICogQHBhcmFtIHNjb3BlLCBieSBkZWZhdWx0ICRyb290U2NvcGUsIGJ1dCBjYW4gYmUgbW9kaWZpZWQgbGF0ZXIgb24gd2l0aCBhdHRhY2ggbWV0aG9kLlxuICAgICAqL1xuXG4gICAgZnVuY3Rpb24gU3Vic2NyaXB0aW9uKHB1YmxpY2F0aW9uLCBzY29wZSkge1xuICAgICAgICB2YXIgc3Vic2NyaXB0aW9uSWQsIG1heFJldmlzaW9uID0gMCwgdGltZXN0YW1wRmllbGQsIGlzU3luY2luZ09uID0gZmFsc2UsIGlzU2luZ2xlLCB1cGRhdGVEYXRhU3RvcmFnZSwgY2FjaGUsIGlzSW5pdGlhbFB1c2hDb21wbGV0ZWQsIGRlZmVycmVkSW5pdGlhbGl6YXRpb247XG4gICAgICAgIHZhciBvblJlYWR5T2ZmLCBmb3JtYXRSZWNvcmQ7XG4gICAgICAgIHZhciByZWNvbm5lY3RPZmYsIHB1YmxpY2F0aW9uTGlzdGVuZXJPZmYsIGRlc3Ryb3lPZmY7XG4gICAgICAgIHZhciBvYmplY3RDbGFzcztcblxuICAgICAgICB2YXIgc0RzID0gdGhpcztcbiAgICAgICAgdmFyIHN1YlBhcmFtcyA9IHt9O1xuICAgICAgICB2YXIgcmVjb3JkU3RhdGVzID0ge307XG4gICAgICAgIHZhciBpbm5lclNjb3BlOy8vPSAkcm9vdFNjb3BlLiRuZXcodHJ1ZSk7XG4gICAgICAgIHZhciBzeW5jTGlzdGVuZXIgPSBuZXcgU3luY0xpc3RlbmVyKCk7XG5cbiAgICAgICAgdGhpcy5yZWFkeSA9IGZhbHNlO1xuICAgICAgICB0aGlzLnN5bmNPbiA9IHN5bmNPbjtcbiAgICAgICAgdGhpcy5zeW5jT2ZmID0gc3luY09mZjtcbiAgICAgICAgdGhpcy5zZXRPblJlYWR5ID0gc2V0T25SZWFkeTtcblxuICAgICAgICB0aGlzLm9uUmVhZHkgPSBvblJlYWR5O1xuICAgICAgICB0aGlzLm9uVXBkYXRlID0gb25VcGRhdGU7XG4gICAgICAgIHRoaXMub25BZGQgPSBvbkFkZDtcbiAgICAgICAgdGhpcy5vblJlbW92ZSA9IG9uUmVtb3ZlO1xuXG4gICAgICAgIHRoaXMuZ2V0RGF0YSA9IGdldERhdGE7XG4gICAgICAgIHRoaXMuc2V0UGFyYW1ldGVycyA9IHNldFBhcmFtZXRlcnM7XG5cbiAgICAgICAgdGhpcy53YWl0Rm9yRGF0YVJlYWR5ID0gd2FpdEZvckRhdGFSZWFkeTtcbiAgICAgICAgdGhpcy53YWl0Rm9yU3Vic2NyaXB0aW9uUmVhZHkgPSB3YWl0Rm9yU3Vic2NyaXB0aW9uUmVhZHk7XG5cbiAgICAgICAgdGhpcy5zZXRGb3JjZSA9IHNldEZvcmNlO1xuICAgICAgICB0aGlzLmlzU3luY2luZyA9IGlzU3luY2luZztcbiAgICAgICAgdGhpcy5pc1JlYWR5ID0gaXNSZWFkeTtcblxuICAgICAgICB0aGlzLnNldFNpbmdsZSA9IHNldFNpbmdsZTtcblxuICAgICAgICB0aGlzLnNldE9iamVjdENsYXNzID0gc2V0T2JqZWN0Q2xhc3M7XG4gICAgICAgIHRoaXMuZ2V0T2JqZWN0Q2xhc3MgPSBnZXRPYmplY3RDbGFzcztcblxuICAgICAgICB0aGlzLmF0dGFjaCA9IGF0dGFjaDtcbiAgICAgICAgdGhpcy5kZXN0cm95ID0gZGVzdHJveTtcblxuICAgICAgICB0aGlzLmlzRXhpc3RpbmdTdGF0ZUZvciA9IGlzRXhpc3RpbmdTdGF0ZUZvcjsgLy8gZm9yIHRlc3RpbmcgcHVycG9zZXNcblxuICAgICAgICBzZXRTaW5nbGUoZmFsc2UpO1xuXG4gICAgICAgIC8vIHRoaXMgd2lsbCBtYWtlIHN1cmUgdGhhdCB0aGUgc3Vic2NyaXB0aW9uIGlzIHJlbGVhc2VkIGZyb20gc2VydmVycyBpZiB0aGUgYXBwIGNsb3NlcyAoY2xvc2UgYnJvd3NlciwgcmVmcmVzaC4uLilcbiAgICAgICAgYXR0YWNoKHNjb3BlIHx8ICRyb290U2NvcGUpO1xuXG4gICAgICAgIC8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy9cblxuICAgICAgICBmdW5jdGlvbiBkZXN0cm95KCkge1xuICAgICAgICAgICAgc3luY09mZigpO1xuICAgICAgICB9XG5cbiAgICAgICAgLyoqIHRoaXMgd2lsbCBiZSBjYWxsZWQgd2hlbiBkYXRhIGlzIGF2YWlsYWJsZSBcbiAgICAgICAgICogIGl0IG1lYW5zIHJpZ2h0IGFmdGVyIGVhY2ggc3luYyFcbiAgICAgICAgICogXG4gICAgICAgICAqIFxuICAgICAgICAqL1xuICAgICAgICBmdW5jdGlvbiBzZXRPblJlYWR5KGNhbGxiYWNrKSB7XG4gICAgICAgICAgICBpZiAob25SZWFkeU9mZikge1xuICAgICAgICAgICAgICAgIG9uUmVhZHlPZmYoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIG9uUmVhZHlPZmYgPSBvblJlYWR5KGNhbGxiYWNrKTtcbiAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgIH1cblxuICAgICAgICAvKipcbiAgICAgICAgICogZm9yY2UgcmVzeW5jaW5nIGZyb20gc2NyYXRjaCBldmVuIGlmIHRoZSBwYXJhbWV0ZXJzIGhhdmUgbm90IGNoYW5nZWRcbiAgICAgICAgICogXG4gICAgICAgICAqIGlmIG91dHNpZGUgY29kZSBoYXMgbW9kaWZpZWQgdGhlIGRhdGEgYW5kIHlvdSBuZWVkIHRvIHJvbGxiYWNrLCB5b3UgY291bGQgY29uc2lkZXIgZm9yY2luZyBhIHJlZnJlc2ggd2l0aCB0aGlzLiBCZXR0ZXIgc29sdXRpb24gc2hvdWxkIGJlIGZvdW5kIHRoYW4gdGhhdC5cbiAgICAgICAgICogXG4gICAgICAgICAqL1xuICAgICAgICBmdW5jdGlvbiBzZXRGb3JjZSh2YWx1ZSkge1xuICAgICAgICAgICAgaWYgKHZhbHVlKSB7XG4gICAgICAgICAgICAgICAgLy8gcXVpY2sgaGFjayB0byBmb3JjZSB0byByZWxvYWQuLi5yZWNvZGUgbGF0ZXIuXG4gICAgICAgICAgICAgICAgc0RzLnN5bmNPZmYoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgIH1cblxuICAgICAgICAvKipcbiAgICAgICAgICogVGhlIGZvbGxvd2luZyBvYmplY3Qgd2lsbCBiZSBidWlsdCB1cG9uIGVhY2ggcmVjb3JkIHJlY2VpdmVkIGZyb20gdGhlIGJhY2tlbmRcbiAgICAgICAgICogXG4gICAgICAgICAqIFRoaXMgY2Fubm90IGJlIG1vZGlmaWVkIGFmdGVyIHRoZSBzeW5jIGhhcyBzdGFydGVkLlxuICAgICAgICAgKiBcbiAgICAgICAgICogQHBhcmFtIGNsYXNzVmFsdWVcbiAgICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIHNldE9iamVjdENsYXNzKGNsYXNzVmFsdWUpIHtcbiAgICAgICAgICAgIGlmIChkZWZlcnJlZEluaXRpYWxpemF0aW9uKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgb2JqZWN0Q2xhc3MgPSBjbGFzc1ZhbHVlO1xuICAgICAgICAgICAgZm9ybWF0UmVjb3JkID0gZnVuY3Rpb24gKHJlY29yZCkge1xuICAgICAgICAgICAgICAgIHJldHVybiBuZXcgb2JqZWN0Q2xhc3MocmVjb3JkKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHNldFNpbmdsZShpc1NpbmdsZSk7XG4gICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gZ2V0T2JqZWN0Q2xhc3MoKSB7XG4gICAgICAgICAgICByZXR1cm4gb2JqZWN0Q2xhc3M7XG4gICAgICAgIH1cblxuICAgICAgICAvKipcbiAgICAgICAgICogdGhpcyBmdW5jdGlvbiBzdGFydHMgdGhlIHN5bmNpbmcuXG4gICAgICAgICAqIE9ubHkgcHVibGljYXRpb24gcHVzaGluZyBkYXRhIG1hdGNoaW5nIG91ciBmZXRjaGluZyBwYXJhbXMgd2lsbCBiZSByZWNlaXZlZC5cbiAgICAgICAgICogXG4gICAgICAgICAqIGV4OiBmb3IgYSBwdWJsaWNhdGlvbiBuYW1lZCBcIm1hZ2F6aW5lcy5zeW5jXCIsIGlmIGZldGNoaW5nIHBhcmFtcyBlcXVhbGxlZCB7bWFnYXppbk5hbWU6J2NhcnMnfSwgdGhlIG1hZ2F6aW5lIGNhcnMgZGF0YSB3b3VsZCBiZSByZWNlaXZlZCBieSB0aGlzIHN1YnNjcmlwdGlvbi5cbiAgICAgICAgICogXG4gICAgICAgICAqIEBwYXJhbSBmZXRjaGluZ1BhcmFtc1xuICAgICAgICAgKiBAcGFyYW0gb3B0aW9uc1xuICAgICAgICAgKiBcbiAgICAgICAgICogQHJldHVybnMgYSBwcm9taXNlIHRoYXQgcmVzb2x2ZXMgd2hlbiBkYXRhIGlzIGFycml2ZWQuXG4gICAgICAgICAqL1xuICAgICAgICBmdW5jdGlvbiBzZXRQYXJhbWV0ZXJzKGZldGNoaW5nUGFyYW1zLCBvcHRpb25zKSB7XG4gICAgICAgICAgICBpZiAoaXNTeW5jaW5nT24gJiYgYW5ndWxhci5lcXVhbHMoZmV0Y2hpbmdQYXJhbXMsIHN1YlBhcmFtcykpIHtcbiAgICAgICAgICAgICAgICAvLyBpZiB0aGUgcGFyYW1zIGhhdmUgbm90IGNoYW5nZWQsIGp1c3QgcmV0dXJucyB3aXRoIGN1cnJlbnQgZGF0YS5cbiAgICAgICAgICAgICAgICByZXR1cm4gc0RzOyAvLyRxLnJlc29sdmUoZ2V0RGF0YSgpKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHN5bmNPZmYoKTtcbiAgICAgICAgICAgIGlmICghaXNTaW5nbGUpIHtcbiAgICAgICAgICAgICAgICBjYWNoZS5sZW5ndGggPSAwO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgbWF4UmV2aXNpb24gPSAwO1xuICAgICAgICAgICAgc3ViUGFyYW1zID0gZmV0Y2hpbmdQYXJhbXMgfHwge307XG4gICAgICAgICAgICBvcHRpb25zID0gb3B0aW9ucyB8fCB7fTtcbiAgICAgICAgICAgIGlmIChhbmd1bGFyLmlzRGVmaW5lZChvcHRpb25zLnNpbmdsZSkpIHtcbiAgICAgICAgICAgICAgICBzZXRTaW5nbGUob3B0aW9ucy5zaW5nbGUpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgc3luY09uKCk7XG4gICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gd2FpdCBmb3IgdGhlIGluaXRpYWwgZmV0Y2ggdG8gY29tcGxldGUgdGhlbiByZXR1cm5zIHRoaXMgc3Vic2NyaXB0aW9uXG4gICAgICAgIGZ1bmN0aW9uIHdhaXRGb3JTdWJzY3JpcHRpb25SZWFkeSgpIHtcbiAgICAgICAgICAgIHJldHVybiBkZWZlcnJlZEluaXRpYWxpemF0aW9uLnByb21pc2UudGhlbihmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gd2FpdCBmb3IgdGhlIGluaXRpYWwgZmV0Y2ggdG8gY29tcGxldGUgdGhlbiByZXR1cm5zIHRoZSBkYXRhXG4gICAgICAgIGZ1bmN0aW9uIHdhaXRGb3JEYXRhUmVhZHkoKSB7XG4gICAgICAgICAgICByZXR1cm4gZGVmZXJyZWRJbml0aWFsaXphdGlvbi5wcm9taXNlO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gZG9lcyB0aGUgZGF0YXNldCByZXR1cm5zIG9ubHkgb25lIG9iamVjdD8gbm90IGFuIGFycmF5P1xuICAgICAgICBmdW5jdGlvbiBzZXRTaW5nbGUodmFsdWUpIHtcbiAgICAgICAgICAgIGlmIChkZWZlcnJlZEluaXRpYWxpemF0aW9uKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaXNTaW5nbGUgPSB2YWx1ZTtcbiAgICAgICAgICAgIGlmICh2YWx1ZSkge1xuICAgICAgICAgICAgICAgIHVwZGF0ZURhdGFTdG9yYWdlID0gdXBkYXRlU3luY2VkT2JqZWN0O1xuICAgICAgICAgICAgICAgIGNhY2hlID0gb2JqZWN0Q2xhc3MgPyBuZXcgb2JqZWN0Q2xhc3Moe30pIDoge307XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHVwZGF0ZURhdGFTdG9yYWdlID0gdXBkYXRlU3luY2VkQXJyYXk7XG4gICAgICAgICAgICAgICAgY2FjaGUgPSBbXTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgIH1cblxuICAgICAgICAvLyByZXR1cm5zIHRoZSBvYmplY3Qgb3IgYXJyYXkgaW4gc3luY1xuICAgICAgICBmdW5jdGlvbiBnZXREYXRhKCkge1xuICAgICAgICAgICAgcmV0dXJuIGNhY2hlO1xuICAgICAgICB9XG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqIHRoZSBkYXRhc2V0IHdpbGwgc3RhcnQgbGlzdGVuaW5nIHRvIHRoZSBkYXRhc3RyZWFtIFxuICAgICAgICAgKiBcbiAgICAgICAgICogTm90ZSBEdXJpbmcgdGhlIHN5bmMsIGl0IHdpbGwgYWxzbyBjYWxsIHRoZSBvcHRpb25hbCBjYWxsYmFja3MgLSBhZnRlciBwcm9jZXNzaW5nIEVBQ0ggcmVjb3JkIHJlY2VpdmVkLlxuICAgICAgICAgKiBcbiAgICAgICAgICogQHJldHVybnMgYSBwcm9taXNlIHRoYXQgd2lsbCBiZSByZXNvbHZlZCB3aGVuIHRoZSBkYXRhIGlzIHJlYWR5LlxuICAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gc3luY09uKCkge1xuICAgICAgICAgICAgaWYgKGlzU3luY2luZ09uKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGRlZmVycmVkSW5pdGlhbGl6YXRpb24ucHJvbWlzZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGRlZmVycmVkSW5pdGlhbGl6YXRpb24gPSAkcS5kZWZlcigpO1xuICAgICAgICAgICAgaXNJbml0aWFsUHVzaENvbXBsZXRlZCA9IGZhbHNlO1xuICAgICAgICAgICAgY29uc29sZS5sb2coJ1N5bmMgJyArIHB1YmxpY2F0aW9uICsgJyBvbi4gUGFyYW1zOicgKyBKU09OLnN0cmluZ2lmeShzdWJQYXJhbXMpKTtcbiAgICAgICAgICAgIGlzU3luY2luZ09uID0gdHJ1ZTtcbiAgICAgICAgICAgIHJlZ2lzdGVyU3Vic2NyaXB0aW9uKCk7XG4gICAgICAgICAgICByZWFkeUZvckxpc3RlbmluZygpO1xuICAgICAgICAgICAgcmV0dXJuIGRlZmVycmVkSW5pdGlhbGl6YXRpb24ucHJvbWlzZTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiB0aGUgZGF0YXNldCBpcyBubyBsb25nZXIgbGlzdGVuaW5nIGFuZCB3aWxsIG5vdCBjYWxsIGFueSBjYWxsYmFja1xuICAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gc3luY09mZigpIHtcbiAgICAgICAgICAgIGlmIChkZWZlcnJlZEluaXRpYWxpemF0aW9uKSB7XG4gICAgICAgICAgICAgICAgLy8gaWYgdGhlcmUgaXMgY29kZSB3YWl0aW5nIG9uIHRoaXMgcHJvbWlzZS4uIGV4IChsb2FkIGluIHJlc29sdmUpXG4gICAgICAgICAgICAgICAgZGVmZXJyZWRJbml0aWFsaXphdGlvbi5yZXNvbHZlKGdldERhdGEoKSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoaXNTeW5jaW5nT24pIHtcbiAgICAgICAgICAgICAgICB1bnJlZ2lzdGVyU3Vic2NyaXB0aW9uKCk7XG4gICAgICAgICAgICAgICAgaXNTeW5jaW5nT24gPSBmYWxzZTtcblxuICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKCdTeW5jICcgKyBwdWJsaWNhdGlvbiArICcgb2ZmLiBQYXJhbXM6JyArIEpTT04uc3RyaW5naWZ5KHN1YlBhcmFtcykpO1xuICAgICAgICAgICAgICAgIGlmIChwdWJsaWNhdGlvbkxpc3RlbmVyT2ZmKSB7XG4gICAgICAgICAgICAgICAgICAgIHB1YmxpY2F0aW9uTGlzdGVuZXJPZmYoKTtcbiAgICAgICAgICAgICAgICAgICAgcHVibGljYXRpb25MaXN0ZW5lck9mZiA9IG51bGw7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGlmIChyZWNvbm5lY3RPZmYpIHtcbiAgICAgICAgICAgICAgICAgICAgcmVjb25uZWN0T2ZmKCk7XG4gICAgICAgICAgICAgICAgICAgIHJlY29ubmVjdE9mZiA9IG51bGw7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gaXNTeW5jaW5nKCkge1xuICAgICAgICAgICAgcmV0dXJuIGlzU3luY2luZ09uO1xuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gcmVhZHlGb3JMaXN0ZW5pbmcoKSB7XG4gICAgICAgICAgICBpZiAoIXB1YmxpY2F0aW9uTGlzdGVuZXJPZmYpIHtcbiAgICAgICAgICAgICAgICBsaXN0ZW5Gb3JSZWNvbm5lY3Rpb25Ub1Jlc3luYygpO1xuICAgICAgICAgICAgICAgIGxpc3RlblRvUHVibGljYXRpb24oKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiAgQnkgZGVmYXVsdCB0aGUgcm9vdHNjb3BlIGlzIGF0dGFjaGVkIGlmIG5vIHNjb3BlIHdhcyBwcm92aWRlZC4gQnV0IGl0IGlzIHBvc3NpYmxlIHRvIHJlLWF0dGFjaCBpdCB0byBhIGRpZmZlcmVudCBzY29wZS4gaWYgdGhlIHN1YnNjcmlwdGlvbiBkZXBlbmRzIG9uIGEgY29udHJvbGxlci5cbiAgICAgICAgICpcbiAgICAgICAgICogIERvIG5vdCBhdHRhY2ggYWZ0ZXIgaXQgaGFzIHN5bmNlZC5cbiAgICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIGF0dGFjaChuZXdTY29wZSkge1xuICAgICAgICAgICAgaWYgKGRlZmVycmVkSW5pdGlhbGl6YXRpb24pIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKGRlc3Ryb3lPZmYpIHtcbiAgICAgICAgICAgICAgICBkZXN0cm95T2ZmKCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpbm5lclNjb3BlID0gbmV3U2NvcGU7XG4gICAgICAgICAgICBkZXN0cm95T2ZmID0gaW5uZXJTY29wZS4kb24oJyRkZXN0cm95JywgZGVzdHJveSk7XG5cbiAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiBsaXN0ZW5Gb3JSZWNvbm5lY3Rpb25Ub1Jlc3luYyhsaXN0ZW5Ob3cpIHtcbiAgICAgICAgICAgIC8vIGdpdmUgYSBjaGFuY2UgdG8gY29ubmVjdCBiZWZvcmUgbGlzdGVuaW5nIHRvIHJlY29ubmVjdGlvbi4uLiBAVE9ETyBzaG91bGQgaGF2ZSB1c2VyX3JlY29ubmVjdGVkX2V2ZW50XG4gICAgICAgICAgICBzZXRUaW1lb3V0KGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICByZWNvbm5lY3RPZmYgPSBpbm5lclNjb3BlLiRvbigndXNlcl9jb25uZWN0ZWQnLCBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnNvbGUuZGVidWcoJ1Jlc3luY2luZyBhZnRlciBuZXR3b3JrIGxvc3MgdG8gJyArIHB1YmxpY2F0aW9uKTtcbiAgICAgICAgICAgICAgICAgICAgLy8gbm90ZSB0aGUgYmFja2VuZCBtaWdodCByZXR1cm4gYSBuZXcgc3Vic2NyaXB0aW9uIGlmIHRoZSBjbGllbnQgdG9vayB0b28gbXVjaCB0aW1lIHRvIHJlY29ubmVjdC5cbiAgICAgICAgICAgICAgICAgICAgcmVnaXN0ZXJTdWJzY3JpcHRpb24oKTtcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH0sIGxpc3Rlbk5vdyA/IDAgOiAyMDAwKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIHJlZ2lzdGVyU3Vic2NyaXB0aW9uKCkge1xuICAgICAgICAgICAgJHNvY2tldGlvLmZldGNoKCdzeW5jLnN1YnNjcmliZScsIHtcbiAgICAgICAgICAgICAgICB2ZXJzaW9uOiBTWU5DX1ZFUlNJT04sXG4gICAgICAgICAgICAgICAgaWQ6IHN1YnNjcmlwdGlvbklkLCAvLyB0byB0cnkgdG8gcmUtdXNlIGV4aXN0aW5nIHN1YmNyaXB0aW9uXG4gICAgICAgICAgICAgICAgcHVibGljYXRpb246IHB1YmxpY2F0aW9uLFxuICAgICAgICAgICAgICAgIHBhcmFtczogc3ViUGFyYW1zXG4gICAgICAgICAgICB9KS50aGVuKGZ1bmN0aW9uIChzdWJJZCkge1xuICAgICAgICAgICAgICAgIHN1YnNjcmlwdGlvbklkID0gc3ViSWQ7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIHVucmVnaXN0ZXJTdWJzY3JpcHRpb24oKSB7XG4gICAgICAgICAgICBpZiAoc3Vic2NyaXB0aW9uSWQpIHtcbiAgICAgICAgICAgICAgICAkc29ja2V0aW8uZmV0Y2goJ3N5bmMudW5zdWJzY3JpYmUnLCB7XG4gICAgICAgICAgICAgICAgICAgIHZlcnNpb246IFNZTkNfVkVSU0lPTixcbiAgICAgICAgICAgICAgICAgICAgaWQ6IHN1YnNjcmlwdGlvbklkXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgc3Vic2NyaXB0aW9uSWQgPSBudWxsO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gbGlzdGVuVG9QdWJsaWNhdGlvbigpIHtcbiAgICAgICAgICAgIC8vIGNhbm5vdCBvbmx5IGxpc3RlbiB0byBzdWJzY3JpcHRpb25JZCB5ZXQuLi5iZWNhdXNlIHRoZSByZWdpc3RyYXRpb24gbWlnaHQgaGF2ZSBhbnN3ZXIgcHJvdmlkZWQgaXRzIGlkIHlldC4uLmJ1dCBzdGFydGVkIGJyb2FkY2FzdGluZyBjaGFuZ2VzLi4uQFRPRE8gY2FuIGJlIGltcHJvdmVkLi4uXG4gICAgICAgICAgICBwdWJsaWNhdGlvbkxpc3RlbmVyT2ZmID0gYWRkUHVibGljYXRpb25MaXN0ZW5lcihwdWJsaWNhdGlvbiwgZnVuY3Rpb24gKGJhdGNoKSB7XG4gICAgICAgICAgICAgICAgaWYgKHN1YnNjcmlwdGlvbklkID09PSBiYXRjaC5zdWJzY3JpcHRpb25JZCB8fCAoIXN1YnNjcmlwdGlvbklkICYmIGNoZWNrRGF0YVNldFBhcmFtc0lmTWF0Y2hpbmdCYXRjaFBhcmFtcyhiYXRjaC5wYXJhbXMpKSkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIWJhdGNoLmRpZmYpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIENsZWFyIHRoZSBjYWNoZSB0byByZWJ1aWxkIGl0IGlmIGFsbCBkYXRhIHdhcyByZWNlaXZlZC5cbiAgICAgICAgICAgICAgICAgICAgICAgIHJlY29yZFN0YXRlcyA9IHt9O1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFpc1NpbmdsZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhY2hlLmxlbmd0aCA9IDA7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgYXBwbHlDaGFuZ2VzKGJhdGNoLnJlY29yZHMpO1xuICAgICAgICAgICAgICAgICAgICBpZiAoIWlzSW5pdGlhbFB1c2hDb21wbGV0ZWQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlzSW5pdGlhbFB1c2hDb21wbGV0ZWQgPSB0cnVlO1xuICAgICAgICAgICAgICAgICAgICAgICAgZGVmZXJyZWRJbml0aWFsaXphdGlvbi5yZXNvbHZlKGdldERhdGEoKSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8qKlxuICAgICAgICAqIGlmIHRoZSBwYXJhbXMgb2YgdGhlIGRhdGFzZXQgbWF0Y2hlcyB0aGUgbm90aWZpY2F0aW9uLCBpdCBtZWFucyB0aGUgZGF0YSBuZWVkcyB0byBiZSBjb2xsZWN0IHRvIHVwZGF0ZSBhcnJheS5cbiAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gY2hlY2tEYXRhU2V0UGFyYW1zSWZNYXRjaGluZ0JhdGNoUGFyYW1zKGJhdGNoUGFyYW1zKSB7XG4gICAgICAgICAgICAvLyBpZiAocGFyYW1zLmxlbmd0aCAhPSBzdHJlYW1QYXJhbXMubGVuZ3RoKSB7XG4gICAgICAgICAgICAvLyAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgLy8gfVxuICAgICAgICAgICAgaWYgKCFzdWJQYXJhbXMgfHwgT2JqZWN0LmtleXMoc3ViUGFyYW1zKS5sZW5ndGggPT0gMCkge1xuICAgICAgICAgICAgICAgIHJldHVybiB0cnVlXG4gICAgICAgICAgICB9XG4gICAgICAgICAgICB2YXIgbWF0Y2hpbmcgPSB0cnVlO1xuICAgICAgICAgICAgZm9yICh2YXIgcGFyYW0gaW4gYmF0Y2hQYXJhbXMpIHtcbiAgICAgICAgICAgICAgICAvLyBhcmUgb3RoZXIgcGFyYW1zIG1hdGNoaW5nP1xuICAgICAgICAgICAgICAgIC8vIGV4OiB3ZSBtaWdodCBoYXZlIHJlY2VpdmUgYSBub3RpZmljYXRpb24gYWJvdXQgdGFza0lkPTIwIGJ1dCB0aGlzIHN1YnNjcmlwdGlvbiBhcmUgb25seSBpbnRlcmVzdGVkIGFib3V0IHRhc2tJZC0zXG4gICAgICAgICAgICAgICAgaWYgKGJhdGNoUGFyYW1zW3BhcmFtXSAhPT0gc3ViUGFyYW1zW3BhcmFtXSkge1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gbWF0Y2hpbmc7XG5cbiAgICAgICAgfVxuXG4gICAgICAgIC8vIGZldGNoIGFsbCB0aGUgbWlzc2luZyByZWNvcmRzLCBhbmQgYWN0aXZhdGUgdGhlIGNhbGwgYmFja3MgKGFkZCx1cGRhdGUscmVtb3ZlKSBhY2NvcmRpbmdseSBpZiB0aGVyZSBpcyBzb21ldGhpbmcgdGhhdCBpcyBuZXcgb3Igbm90IGFscmVhZHkgaW4gc3luYy5cbiAgICAgICAgZnVuY3Rpb24gYXBwbHlDaGFuZ2VzKHJlY29yZHMpIHtcbiAgICAgICAgICAgIHZhciBuZXdEYXRhQXJyYXkgPSBbXTtcbiAgICAgICAgICAgIHZhciBuZXdEYXRhO1xuICAgICAgICAgICAgc0RzLnJlYWR5ID0gZmFsc2U7XG4gICAgICAgICAgICByZWNvcmRzLmZvckVhY2goZnVuY3Rpb24gKHJlY29yZCkge1xuICAgICAgICAgICAgICAgIC8vICAgICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKCdEYXRhc3luYyBbJyArIGRhdGFTdHJlYW1OYW1lICsgJ10gcmVjZWl2ZWQ6JyArSlNPTi5zdHJpbmdpZnkocmVjb3JkKSk7Ly8rIHJlY29yZC5pZCk7XG4gICAgICAgICAgICAgICAgaWYgKHJlY29yZC5yZW1vdmUpIHtcbiAgICAgICAgICAgICAgICAgICAgcmVtb3ZlUmVjb3JkKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChyZWNvcmRTdGF0ZXNbcmVjb3JkLmlkXSkge1xuICAgICAgICAgICAgICAgICAgICAvLyBpZiB0aGUgcmVjb3JkIGlzIGFscmVhZHkgcHJlc2VudCBpbiB0aGUgY2FjaGUuLi5zbyBpdCBpcyBtaWdodGJlIGFuIHVwZGF0ZS4uXG4gICAgICAgICAgICAgICAgICAgIG5ld0RhdGEgPSB1cGRhdGVSZWNvcmQocmVjb3JkKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBuZXdEYXRhID0gYWRkUmVjb3JkKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGlmIChuZXdEYXRhKSB7XG4gICAgICAgICAgICAgICAgICAgIG5ld0RhdGFBcnJheS5wdXNoKG5ld0RhdGEpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgc0RzLnJlYWR5ID0gdHJ1ZTtcbiAgICAgICAgICAgIGlmIChpc1NpbmdsZSkge1xuICAgICAgICAgICAgICAgIHN5bmNMaXN0ZW5lci5ub3RpZnkoJ3JlYWR5JywgZ2V0RGF0YSgpKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgc3luY0xpc3RlbmVyLm5vdGlmeSgncmVhZHknLCBnZXREYXRhKCksIG5ld0RhdGFBcnJheSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICAvKipcbiAgICAgICAgICogQWx0aG91Z2ggbW9zdCBjYXNlcyBhcmUgaGFuZGxlZCB1c2luZyBvblJlYWR5LCB0aGlzIHRlbGxzIHlvdSB0aGUgY3VycmVudCBkYXRhIHN0YXRlLlxuICAgICAgICAgKiBcbiAgICAgICAgICogQHJldHVybnMgaWYgdHJ1ZSBpcyBhIHN5bmMgaGFzIGJlZW4gcHJvY2Vzc2VkIG90aGVyd2lzZSBmYWxzZSBpZiB0aGUgZGF0YSBpcyBub3QgcmVhZHkuXG4gICAgICAgICAqL1xuICAgICAgICBmdW5jdGlvbiBpc1JlYWR5KCkge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMucmVhZHk7XG4gICAgICAgIH1cbiAgICAgICAgLyoqXG4gICAgICAgICAqIFxuICAgICAgICAgKiByZXR1cm5zIGEgZnVuY3Rpb24gdG8gcmVtb3ZlIHRoZSBsaXN0ZW5lci5cbiAgICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIG9uQWRkKGNhbGxiYWNrKSB7XG4gICAgICAgICAgICByZXR1cm4gc3luY0xpc3RlbmVyLm9uKCdhZGQnLCBjYWxsYmFjayk7XG4gICAgICAgIH1cblxuICAgICAgICAvKipcbiAgICAgICAgICogXG4gICAgICAgICAqIHJldHVybnMgYSBmdW5jdGlvbiB0byByZW1vdmUgdGhlIGxpc3RlbmVyLlxuICAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gb25VcGRhdGUoY2FsbGJhY2spIHtcbiAgICAgICAgICAgIHJldHVybiBzeW5jTGlzdGVuZXIub24oJ3VwZGF0ZScsIGNhbGxiYWNrKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiBcbiAgICAgICAgICogcmV0dXJucyBhIGZ1bmN0aW9uIHRvIHJlbW92ZSB0aGUgbGlzdGVuZXIuXG4gICAgICAgICAqL1xuICAgICAgICBmdW5jdGlvbiBvblJlbW92ZShjYWxsYmFjaykge1xuICAgICAgICAgICAgcmV0dXJuIHN5bmNMaXN0ZW5lci5vbigncmVtb3ZlJywgY2FsbGJhY2spO1xuICAgICAgICB9XG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqIFxuICAgICAgICAgKiByZXR1cm5zIGEgZnVuY3Rpb24gdG8gcmVtb3ZlIHRoZSBsaXN0ZW5lci5cbiAgICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIG9uUmVhZHkoY2FsbGJhY2spIHtcbiAgICAgICAgICAgIHJldHVybiBzeW5jTGlzdGVuZXIub24oJ3JlYWR5JywgY2FsbGJhY2spO1xuICAgICAgICB9XG5cblxuICAgICAgICBmdW5jdGlvbiBhZGRSZWNvcmQocmVjb3JkKSB7XG4gICAgICAgICAgICBjb25zb2xlLmRlYnVnKCdTeW5jIC0+IEluc2VydGVkIE5ldyByZWNvcmQgIycgKyByZWNvcmQuaWQgKyAnIGZvciBzdWJzY3JpcHRpb24gdG8gJyArIHB1YmxpY2F0aW9uKTsvLyBKU09OLnN0cmluZ2lmeShyZWNvcmQpKTtcbiAgICAgICAgICAgIGdldFJldmlzaW9uKHJlY29yZCk7IC8vIGp1c3QgbWFrZSBzdXJlIHdlIGNhbiBnZXQgYSByZXZpc2lvbiBiZWZvcmUgd2UgaGFuZGxlIHRoaXMgcmVjb3JkXG4gICAgICAgICAgICB1cGRhdGVEYXRhU3RvcmFnZShmb3JtYXRSZWNvcmQgPyBmb3JtYXRSZWNvcmQocmVjb3JkKSA6IHJlY29yZCk7XG4gICAgICAgICAgICBzeW5jTGlzdGVuZXIubm90aWZ5KCdhZGQnLCByZWNvcmQpO1xuICAgICAgICAgICAgcmV0dXJuIHJlY29yZDtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIHVwZGF0ZVJlY29yZChyZWNvcmQpIHtcbiAgICAgICAgICAgIHZhciBwcmV2aW91cyA9IHJlY29yZFN0YXRlc1tyZWNvcmQuaWRdO1xuICAgICAgICAgICAgaWYgKGdldFJldmlzaW9uKHJlY29yZCkgPD0gZ2V0UmV2aXNpb24ocHJldmlvdXMpKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zb2xlLmRlYnVnKCdTeW5jIC0+IFVwZGF0ZWQgcmVjb3JkICMnICsgcmVjb3JkLmlkICsgJyBmb3Igc3Vic2NyaXB0aW9uIHRvICcgKyBwdWJsaWNhdGlvbik7Ly8gSlNPTi5zdHJpbmdpZnkocmVjb3JkKSk7XG4gICAgICAgICAgICB1cGRhdGVEYXRhU3RvcmFnZShmb3JtYXRSZWNvcmQgPyBmb3JtYXRSZWNvcmQocmVjb3JkKSA6IHJlY29yZCk7XG4gICAgICAgICAgICBzeW5jTGlzdGVuZXIubm90aWZ5KCd1cGRhdGUnLCByZWNvcmQpO1xuICAgICAgICAgICAgcmV0dXJuIHJlY29yZDtcbiAgICAgICAgfVxuXG5cbiAgICAgICAgZnVuY3Rpb24gcmVtb3ZlUmVjb3JkKHJlY29yZCkge1xuICAgICAgICAgICAgdmFyIHByZXZpb3VzID0gcmVjb3JkU3RhdGVzW3JlY29yZC5pZF07XG4gICAgICAgICAgICBpZiAoIXByZXZpb3VzIHx8IGdldFJldmlzaW9uKHJlY29yZCkgPiBnZXRSZXZpc2lvbihwcmV2aW91cykpIHtcbiAgICAgICAgICAgICAgICBjb25zb2xlLmRlYnVnKCdTeW5jIC0+IFJlbW92ZWQgIycgKyByZWNvcmQuaWQgKyAnIGZvciBzdWJzY3JpcHRpb24gdG8gJyArIHB1YmxpY2F0aW9uKTtcbiAgICAgICAgICAgICAgICAvLyBXZSBjb3VsZCBoYXZlIGZvciB0aGUgc2FtZSByZWNvcmQgY29uc2VjdXRpdmVseSBmZXRjaGluZyBpbiB0aGlzIG9yZGVyOlxuICAgICAgICAgICAgICAgIC8vIGRlbGV0ZSBpZDo0LCByZXYgMTAsIHRoZW4gYWRkIGlkOjQsIHJldiA5Li4uLiBieSBrZWVwaW5nIHRyYWNrIG9mIHdoYXQgd2FzIGRlbGV0ZWQsIHdlIHdpbGwgbm90IGFkZCB0aGUgcmVjb3JkIHNpbmNlIGl0IHdhcyBkZWxldGVkIHdpdGggYSBtb3N0IHJlY2VudCB0aW1lc3RhbXAuXG4gICAgICAgICAgICAgICAgcmVjb3JkLnJlbW92ZWQgPSB0cnVlOyAvLyBTbyB3ZSBvbmx5IGZsYWcgYXMgcmVtb3ZlZCwgbGF0ZXIgb24gdGhlIGdhcmJhZ2UgY29sbGVjdG9yIHdpbGwgZ2V0IHJpZCBvZiBpdC4gICAgICAgICBcbiAgICAgICAgICAgICAgICB1cGRhdGVEYXRhU3RvcmFnZShyZWNvcmQpO1xuICAgICAgICAgICAgICAgIC8vIGlmIHRoZXJlIGlzIG5vIHByZXZpb3VzIHJlY29yZCB3ZSBkbyBub3QgbmVlZCB0byByZW1vdmVkIGFueSB0aGluZyBmcm9tIG91ciBzdG9yYWdlLiAgICAgXG4gICAgICAgICAgICAgICAgaWYgKHByZXZpb3VzKSB7XG4gICAgICAgICAgICAgICAgICAgIHN5bmNMaXN0ZW5lci5ub3RpZnkoJ3JlbW92ZScsIHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgIGRpc3Bvc2UocmVjb3JkKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgZnVuY3Rpb24gZGlzcG9zZShyZWNvcmQpIHtcbiAgICAgICAgICAgICRzeW5jR2FyYmFnZUNvbGxlY3Rvci5kaXNwb3NlKGZ1bmN0aW9uIGNvbGxlY3QoKSB7XG4gICAgICAgICAgICAgICAgdmFyIGV4aXN0aW5nUmVjb3JkID0gcmVjb3JkU3RhdGVzW3JlY29yZC5pZF07XG4gICAgICAgICAgICAgICAgaWYgKGV4aXN0aW5nUmVjb3JkICYmIHJlY29yZC5yZXZpc2lvbiA+PSBleGlzdGluZ1JlY29yZC5yZXZpc2lvblxuICAgICAgICAgICAgICAgICkge1xuICAgICAgICAgICAgICAgICAgICAvL2NvbnNvbGUuZGVidWcoJ0NvbGxlY3QgTm93OicgKyBKU09OLnN0cmluZ2lmeShyZWNvcmQpKTtcbiAgICAgICAgICAgICAgICAgICAgZGVsZXRlIHJlY29yZFN0YXRlc1tyZWNvcmQuaWRdO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gaXNFeGlzdGluZ1N0YXRlRm9yKHJlY29yZElkKSB7XG4gICAgICAgICAgICByZXR1cm4gISFyZWNvcmRTdGF0ZXNbcmVjb3JkSWRdO1xuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gdXBkYXRlU3luY2VkT2JqZWN0KHJlY29yZCkge1xuICAgICAgICAgICAgcmVjb3JkU3RhdGVzW3JlY29yZC5pZF0gPSByZWNvcmQ7XG4gICAgICAgICAgICBjbGVhck9iamVjdChjYWNoZSk7XG4gICAgICAgICAgICBpZiAoIXJlY29yZC5yZW1vdmUpIHtcbiAgICAgICAgICAgICAgICBhbmd1bGFyLmV4dGVuZChjYWNoZSwgcmVjb3JkKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIHVwZGF0ZVN5bmNlZEFycmF5KHJlY29yZCkge1xuICAgICAgICAgICAgdmFyIGV4aXN0aW5nID0gcmVjb3JkU3RhdGVzW3JlY29yZC5pZF07XG4gICAgICAgICAgICBpZiAoIWV4aXN0aW5nKSB7XG4gICAgICAgICAgICAgICAgLy8gYWRkIG5ldyBpbnN0YW5jZVxuICAgICAgICAgICAgICAgIHJlY29yZFN0YXRlc1tyZWNvcmQuaWRdID0gcmVjb3JkO1xuICAgICAgICAgICAgICAgIGlmICghcmVjb3JkLnJlbW92ZWQpIHtcbiAgICAgICAgICAgICAgICAgICAgY2FjaGUucHVzaChyZWNvcmQpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgLy8gdXBkYXRlIHRoZSBpbnN0YW5jZVxuICAgICAgICAgICAgICAgIGNsZWFyT2JqZWN0KGV4aXN0aW5nKTtcbiAgICAgICAgICAgICAgICBhbmd1bGFyLmV4dGVuZChleGlzdGluZywgcmVjb3JkKTtcbiAgICAgICAgICAgICAgICBpZiAocmVjb3JkLnJlbW92ZWQpIHtcbiAgICAgICAgICAgICAgICAgICAgY2FjaGUuc3BsaWNlKGNhY2hlLmluZGV4T2YoZXhpc3RpbmcpLCAxKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiBjbGVhck9iamVjdChvYmplY3QpIHtcbiAgICAgICAgICAgIE9iamVjdC5rZXlzKG9iamVjdCkuZm9yRWFjaChmdW5jdGlvbiAoa2V5KSB7IGRlbGV0ZSBvYmplY3Rba2V5XTsgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiBnZXRSZXZpc2lvbihyZWNvcmQpIHtcbiAgICAgICAgICAgIC8vIHdoYXQgcmVzZXJ2ZWQgZmllbGQgZG8gd2UgdXNlIGFzIHRpbWVzdGFtcFxuICAgICAgICAgICAgaWYgKGFuZ3VsYXIuaXNEZWZpbmVkKHJlY29yZC5yZXZpc2lvbikpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gcmVjb3JkLnJldmlzaW9uO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKGFuZ3VsYXIuaXNEZWZpbmVkKHJlY29yZC50aW1lc3RhbXApKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlY29yZC50aW1lc3RhbXA7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICB0aHJvdyBuZXcgRXJyb3IoJ1N5bmMgcmVxdWlyZXMgYSByZXZpc2lvbiBvciB0aW1lc3RhbXAgcHJvcGVydHkgaW4gcmVjZWl2ZWQgJyArIChvYmplY3RDbGFzcyA/ICdvYmplY3QgWycgKyBvYmplY3RDbGFzcy5uYW1lICsgJ10nIDogJ3JlY29yZCcpKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIC8qKlxuICAgICAqIHRoaXMgb2JqZWN0IFxuICAgICAqL1xuICAgIGZ1bmN0aW9uIFN5bmNMaXN0ZW5lcigpIHtcbiAgICAgICAgdmFyIGV2ZW50cyA9IHt9O1xuICAgICAgICB2YXIgY291bnQgPSAwO1xuXG4gICAgICAgIHRoaXMubm90aWZ5ID0gbm90aWZ5O1xuICAgICAgICB0aGlzLm9uID0gb247XG5cbiAgICAgICAgZnVuY3Rpb24gbm90aWZ5KGV2ZW50LCBkYXRhMSwgZGF0YTIpIHtcbiAgICAgICAgICAgIHZhciBsaXN0ZW5lcnMgPSBldmVudHNbZXZlbnRdO1xuICAgICAgICAgICAgaWYgKGxpc3RlbmVycykge1xuICAgICAgICAgICAgICAgIF8uZm9yRWFjaChsaXN0ZW5lcnMsIGZ1bmN0aW9uIChjYWxsYmFjaywgaWQpIHtcbiAgICAgICAgICAgICAgICAgICAgY2FsbGJhY2soZGF0YTEsIGRhdGEyKTtcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiBAcmV0dXJucyBoYW5kbGVyIHRvIHVucmVnaXN0ZXIgbGlzdGVuZXJcbiAgICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIG9uKGV2ZW50LCBjYWxsYmFjaykge1xuICAgICAgICAgICAgdmFyIGxpc3RlbmVycyA9IGV2ZW50c1tldmVudF07XG4gICAgICAgICAgICBpZiAoIWxpc3RlbmVycykge1xuICAgICAgICAgICAgICAgIGxpc3RlbmVycyA9IGV2ZW50c1tldmVudF0gPSB7fTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHZhciBpZCA9IGNvdW50Kys7XG4gICAgICAgICAgICBsaXN0ZW5lcnNbaWQrK10gPSBjYWxsYmFjaztcbiAgICAgICAgICAgIHJldHVybiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgZGVsZXRlIGxpc3RlbmVyc1tpZF07XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICB9XG4gICAgZnVuY3Rpb24gZ2V0Q29uc29sZSgpIHtcbiAgICAgICAgLy8gdG8gaGVscCB3aXRoIGRlYnVnZ2luZyBmb3Igbm93IHVudGlsIHdlIG9wdCBmb3IgYSBuaWNlIGxvZ2dlci4gSW4gcHJvZHVjdGlvbiwgbG9nIGFuZCBkZWJ1ZyBzaG91bGQgYXV0b21hdGljYWxseSBiZSByZW1vdmVkIGJ5IHRoZSBidWlsZCBmcm9tIHRoZSBjb2RlLi4uLiBUT0RPOm5lZWQgdG8gY2hlY2sgb3V0IHRoZSBwcm9kdWN0aW9uIGNvZGVcbiAgICAgICAgcmV0dXJuIHtcbiAgICAgICAgICAgIGxvZzogZnVuY3Rpb24gKG1zZykge1xuICAgICAgICAgICAgICAgIHdpbmRvdy5jb25zb2xlLmRlYnVnKCdTWU5DKGluZm8pOiAnICsgbXNnKTtcbiAgICAgICAgICAgIH0sXG4gICAgICAgICAgICBkZWJ1ZzogZnVuY3Rpb24gKG1zZykge1xuICAgICAgICAgICAgICAgIC8vICB3aW5kb3cuY29uc29sZS5kZWJ1ZygnU1lOQyhkZWJ1Zyk6ICcgKyBtc2cpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9O1xuICAgIH1cbn07XG59KCkpO1xuXG4iLCJhbmd1bGFyXG4gICAgLm1vZHVsZSgnc3luYycsIFsnc29ja2V0aW8tYXV0aCddKVxuICAgIC5jb25maWcoZnVuY3Rpb24oJHNvY2tldGlvUHJvdmlkZXIpe1xuICAgICAgICAkc29ja2V0aW9Qcm92aWRlci5zZXREZWJ1Zyh0cnVlKTtcbiAgICB9KTtcbiIsImFuZ3VsYXJcbiAgICAubW9kdWxlKCdzeW5jJylcbiAgICAuZmFjdG9yeSgnJHN5bmNHYXJiYWdlQ29sbGVjdG9yJywgc3luY0dhcmJhZ2VDb2xsZWN0b3IpO1xuXG4vKipcbiAqIHNhZmVseSByZW1vdmUgZGVsZXRlZCByZWNvcmQvb2JqZWN0IGZyb20gbWVtb3J5IGFmdGVyIHRoZSBzeW5jIHByb2Nlc3MgZGlzcG9zZWQgdGhlbS5cbiAqIFxuICogVE9ETzogU2Vjb25kcyBzaG91bGQgcmVmbGVjdCB0aGUgbWF4IHRpbWUgIHRoYXQgc3luYyBjYWNoZSBpcyB2YWxpZCAobmV0d29yayBsb3NzIHdvdWxkIGZvcmNlIGEgcmVzeW5jKSwgd2hpY2ggc2hvdWxkIG1hdGNoIG1heERpc2Nvbm5lY3Rpb25UaW1lQmVmb3JlRHJvcHBpbmdTdWJzY3JpcHRpb24gb24gdGhlIHNlcnZlciBzaWRlLlxuICogXG4gKiBOb3RlOlxuICogcmVtb3ZlZCByZWNvcmQgc2hvdWxkIGJlIGRlbGV0ZWQgZnJvbSB0aGUgc3luYyBpbnRlcm5hbCBjYWNoZSBhZnRlciBhIHdoaWxlIHNvIHRoYXQgdGhleSBkbyBub3Qgc3RheSBpbiB0aGUgbWVtb3J5LiBUaGV5IGNhbm5vdCBiZSByZW1vdmVkIHRvbyBlYXJseSBhcyBhbiBvbGRlciB2ZXJzaW9uL3N0YW1wIG9mIHRoZSByZWNvcmQgY291bGQgYmUgcmVjZWl2ZWQgYWZ0ZXIgaXRzIHJlbW92YWwuLi53aGljaCB3b3VsZCByZS1hZGQgdG8gY2FjaGUuLi5kdWUgYXN5bmNocm9ub3VzIHByb2Nlc3NpbmcuLi5cbiAqL1xuZnVuY3Rpb24gc3luY0dhcmJhZ2VDb2xsZWN0b3IoKSB7XG4gICAgdmFyIGl0ZW1zID0gW107XG4gICAgdmFyIHNlY29uZHMgPSAyO1xuICAgIHZhciBzY2hlZHVsZWQgPSBmYWxzZTtcblxuICAgIHZhciBzZXJ2aWNlID0ge1xuICAgICAgICBzZXRTZWNvbmRzOiBzZXRTZWNvbmRzLFxuICAgICAgICBnZXRTZWNvbmRzOiBnZXRTZWNvbmRzLFxuICAgICAgICBkaXNwb3NlOiBkaXNwb3NlLFxuICAgICAgICBzY2hlZHVsZTogc2NoZWR1bGUsXG4gICAgICAgIHJ1bjogcnVuLFxuICAgICAgICBnZXRJdGVtQ291bnQ6IGdldEl0ZW1Db3VudFxuICAgIH07XG5cbiAgICByZXR1cm4gc2VydmljZTtcblxuICAgIC8vLy8vLy8vLy9cblxuICAgIGZ1bmN0aW9uIHNldFNlY29uZHModmFsdWUpIHtcbiAgICAgICAgc2Vjb25kcyA9IHZhbHVlO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIGdldFNlY29uZHMoKSB7XG4gICAgICAgIHJldHVybiBzZWNvbmRzO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIGdldEl0ZW1Db3VudCgpIHtcbiAgICAgICAgcmV0dXJuIGl0ZW1zLmxlbmd0aDtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBkaXNwb3NlKGNvbGxlY3QpIHtcbiAgICAgICAgaXRlbXMucHVzaCh7XG4gICAgICAgICAgICB0aW1lc3RhbXA6IERhdGUubm93KCksXG4gICAgICAgICAgICBjb2xsZWN0OiBjb2xsZWN0XG4gICAgICAgIH0pO1xuICAgICAgICBpZiAoIXNjaGVkdWxlZCkge1xuICAgICAgICAgICAgc2VydmljZS5zY2hlZHVsZSgpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gc2NoZWR1bGUoKSB7XG4gICAgICAgIGlmICghc2Vjb25kcykge1xuICAgICAgICAgICAgc2VydmljZS5ydW4oKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBzY2hlZHVsZWQgPSB0cnVlO1xuICAgICAgICBzZXRUaW1lb3V0KGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIHNlcnZpY2UucnVuKCk7XG4gICAgICAgICAgICBpZiAoaXRlbXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICAgIHNjaGVkdWxlKCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHNjaGVkdWxlZCA9IGZhbHNlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9LCBzZWNvbmRzICogMTAwMCk7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gcnVuKCkge1xuICAgICAgICB2YXIgdGltZW91dCA9IERhdGUubm93KCkgLSBzZWNvbmRzICogMTAwMDtcbiAgICAgICAgd2hpbGUgKGl0ZW1zLmxlbmd0aCA+IDAgJiYgaXRlbXNbMF0udGltZXN0YW1wIDw9IHRpbWVvdXQpIHtcbiAgICAgICAgICAgIGl0ZW1zLnNoaWZ0KCkuY29sbGVjdCgpO1xuICAgICAgICB9XG4gICAgfVxufVxuXG5cbiIsIlxuLyoqXG4gKiBcbiAqIFNlcnZpY2UgdGhhdCBhbGxvd3MgYW4gYXJyYXkgb2YgZGF0YSByZW1haW4gaW4gc3luYyB3aXRoIGJhY2tlbmQuXG4gKiBcbiAqIFxuICogZXg6XG4gKiB3aGVuIHRoZXJlIGlzIGEgbm90aWZpY2F0aW9uLCBub3RpY2F0aW9uU2VydmljZSBub3RpZmllcyB0aGF0IHRoZXJlIGlzIHNvbWV0aGluZyBuZXcuLi50aGVuIHRoZSBkYXRhc2V0IGdldCB0aGUgZGF0YSBhbmQgbm90aWZpZXMgYWxsIGl0cyBjYWxsYmFjay5cbiAqIFxuICogTk9URTogXG4gKiAgXG4gKiBcbiAqIFByZS1SZXF1aXN0ZTpcbiAqIC0tLS0tLS0tLS0tLS1cbiAqIFN5bmMgZG9lcyBub3Qgd29yayBpZiBvYmplY3RzIGRvIG5vdCBoYXZlIEJPVEggaWQgYW5kIHJldmlzaW9uIGZpZWxkISEhIVxuICogXG4gKiBXaGVuIHRoZSBiYWNrZW5kIHdyaXRlcyBhbnkgZGF0YSB0byB0aGUgZGIgdGhhdCBhcmUgc3VwcG9zZWQgdG8gYmUgc3luY3Jvbml6ZWQ6XG4gKiBJdCBtdXN0IG1ha2Ugc3VyZSBlYWNoIGFkZCwgdXBkYXRlLCByZW1vdmFsIG9mIHJlY29yZCBpcyB0aW1lc3RhbXBlZC5cbiAqIEl0IG11c3Qgbm90aWZ5IHRoZSBkYXRhc3RyZWFtICh3aXRoIG5vdGlmeUNoYW5nZSBvciBub3RpZnlSZW1vdmFsKSB3aXRoIHNvbWUgcGFyYW1zIHNvIHRoYXQgYmFja2VuZCBrbm93cyB0aGF0IGl0IGhhcyB0byBwdXNoIGJhY2sgdGhlIGRhdGEgYmFjayB0byB0aGUgc3Vic2NyaWJlcnMgKGV4OiB0aGUgdGFza0NyZWF0aW9uIHdvdWxkIG5vdGlmeSB3aXRoIGl0cyBwbGFuSWQpXG4qIFxuICogXG4gKi9cbmFuZ3VsYXJcbiAgICAubW9kdWxlKCdzeW5jJylcbiAgICAuZmFjdG9yeSgnJHN5bmMnLCBzeW5jKTtcblxuZnVuY3Rpb24gc3luYygkcm9vdFNjb3BlLCAkcSwgJHNvY2tldGlvLCAkc3luY0dhcmJhZ2VDb2xsZWN0b3IpIHtcbiAgICB2YXIgcHVibGljYXRpb25MaXN0ZW5lcnMgPSB7fSxcbiAgICAgICAgcHVibGljYXRpb25MaXN0ZW5lckNvdW50ID0gMDtcbiAgICB2YXIgR1JBQ0VfUEVSSU9EX0lOX1NFQ09ORFMgPSA4O1xuICAgIHZhciBTWU5DX1ZFUlNJT04gPSAnMS4wJztcbiAgICB2YXIgY29uc29sZSA9IGdldENvbnNvbGUoKTtcblxuICAgIGxpc3RlblRvU3luY05vdGlmaWNhdGlvbigpO1xuXG4gICAgdmFyIHNlcnZpY2UgPSB7XG4gICAgICAgIHN1YnNjcmliZTogc3Vic2NyaWJlLFxuICAgICAgICByZXNvbHZlU3Vic2NyaXB0aW9uOiByZXNvbHZlU3Vic2NyaXB0aW9uLFxuICAgICAgICBnZXRHcmFjZVBlcmlvZDogZ2V0R3JhY2VQZXJpb2RcbiAgICB9O1xuXG4gICAgcmV0dXJuIHNlcnZpY2U7XG5cbiAgICAvLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vL1xuICAgIC8qKlxuICAgICAqIHN1YnNjcmliZSB0byBwdWJsaWNhdGlvbiBhbmQgcmV0dXJucyB0aGUgc3Vic2NyaXB0aW9uIHdoZW4gZGF0YSBpcyBhdmFpbGFibGUuIFxuICAgICAqIEBwYXJhbSBwdWJsaWNhdGlvbiBuYW1lLiBvbiB0aGUgc2VydmVyIHNpZGUsIGEgcHVibGljYXRpb24gc2hhbGwgZXhpc3QuIGV4OiBtYWdhemluZXMuc3luY1xuICAgICAqIEBwYXJhbSBwYXJhbXMgICB0aGUgcGFyYW1zIG9iamVjdCBwYXNzZWQgdG8gdGhlIHN1YnNjcmlwdGlvbiwgZXg6IHttYWdhemluZUlkOidlbnRyZXByZW5ldXInfSlcbiAgICAgKiBAcGFyYW0gb2JqZWN0Q2xhc3MgYW4gaW5zdGFuY2Ugb2YgdGhpcyBjbGFzcyB3aWxsIGJlIGNyZWF0ZWQgZm9yIGVhY2ggcmVjb3JkIHJlY2VpdmVkLlxuICAgICAqIHJldHVybnMgYSBwcm9taXNlIHJldHVybmluZyB0aGUgc3Vic2NyaXB0aW9uIHdoZW4gdGhlIGRhdGEgaXMgc3luY2VkXG4gICAgICogb3IgcmVqZWN0cyBpZiB0aGUgaW5pdGlhbCBzeW5jIGZhaWxzIHRvIGNvbXBsZXRlIGluIGEgbGltaXRlZCBhbW91bnQgb2YgdGltZS4gXG4gICAgICogXG4gICAgICogdG8gZ2V0IHRoZSBkYXRhIGZyb20gdGhlIGRhdGFTZXQsIGp1c3QgZGF0YVNldC5nZXREYXRhKClcbiAgICAgKi9cbiAgICBmdW5jdGlvbiByZXNvbHZlU3Vic2NyaXB0aW9uKHB1YmxpY2F0aW9uTmFtZSwgcGFyYW1zLCBvYmplY3RDbGFzcykge1xuICAgICAgICB2YXIgZGVmZXJyZWQgPSAkcS5kZWZlcigpO1xuICAgICAgICB2YXIgc0RzID0gc3Vic2NyaWJlKHB1YmxpY2F0aW9uTmFtZSkuc2V0T2JqZWN0Q2xhc3Mob2JqZWN0Q2xhc3MpO1xuXG4gICAgICAgIC8vIGdpdmUgYSBsaXR0bGUgdGltZSBmb3Igc3Vic2NyaXB0aW9uIHRvIGZldGNoIHRoZSBkYXRhLi4ub3RoZXJ3aXNlIGdpdmUgdXAgc28gdGhhdCB3ZSBkb24ndCBnZXQgc3R1Y2sgaW4gYSByZXNvbHZlIHdhaXRpbmcgZm9yZXZlci5cbiAgICAgICAgdmFyIGdyYWNlUGVyaW9kID0gc2V0VGltZW91dChmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICBpZiAoIXNEcy5yZWFkeSkge1xuICAgICAgICAgICAgICAgIHNEcy5kZXN0cm95KCk7XG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2coJ0F0dGVtcHQgdG8gc3Vic2NyaWJlIHRvIHB1YmxpY2F0aW9uICcgKyBwdWJsaWNhdGlvbk5hbWUgKyAnIGZhaWxlZCcpO1xuICAgICAgICAgICAgICAgIGRlZmVycmVkLnJlamVjdCgnU1lOQ19USU1FT1VUJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0sIEdSQUNFX1BFUklPRF9JTl9TRUNPTkRTICogMTAwMCk7XG5cbiAgICAgICAgc0RzLnNldFBhcmFtZXRlcnMocGFyYW1zKVxuICAgICAgICAgICAgLndhaXRGb3JEYXRhUmVhZHkoKVxuICAgICAgICAgICAgLnRoZW4oZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgIGNsZWFyVGltZW91dChncmFjZVBlcmlvZCk7XG4gICAgICAgICAgICAgICAgZGVmZXJyZWQucmVzb2x2ZShzRHMpO1xuICAgICAgICAgICAgfSkuY2F0Y2goZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgIGNsZWFyVGltZW91dChncmFjZVBlcmlvZCk7XG4gICAgICAgICAgICAgICAgc0RzLmRlc3Ryb3koKTtcbiAgICAgICAgICAgICAgICBkZWZlcnJlZC5yZWplY3QoJ0ZhaWxlZCB0byBzdWJzY3JpYmUgdG8gcHVibGljYXRpb24gJyArIHB1YmxpY2F0aW9uTmFtZSArICcgZmFpbGVkJyk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuIGRlZmVycmVkLnByb21pc2U7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogXG4gICAgICogZm9yIHRlc3QgcHVycG9zZXMsIHJldHVybnMgdGhlIHRpbWUgcmVzb2x2ZVN1YnNjcmlwdGlvbiBiZWZvcmUgaXQgdGltZXMgb3V0LlxuICAgICAqL1xuICAgIGZ1bmN0aW9uIGdldEdyYWNlUGVyaW9kKCkge1xuICAgICAgICByZXR1cm4gR1JBQ0VfUEVSSU9EX0lOX1NFQ09ORFM7XG4gICAgfVxuICAgIC8qKlxuICAgICAqIHN1YnNjcmliZSB0byBwdWJsaWNhdGlvbi4gSXQgd2lsbCBub3Qgc3luYyB1bnRpbCB5b3Ugc2V0IHRoZSBwYXJhbXMuXG4gICAgICogXG4gICAgICogQHBhcmFtIHB1YmxpY2F0aW9uIG5hbWUuIG9uIHRoZSBzZXJ2ZXIgc2lkZSwgYSBwdWJsaWNhdGlvbiBzaGFsbCBleGlzdC4gZXg6IG1hZ2F6aW5lcy5zeW5jXG4gICAgICogQHBhcmFtIHBhcmFtcyAgIHRoZSBwYXJhbXMgb2JqZWN0IHBhc3NlZCB0byB0aGUgc3Vic2NyaXB0aW9uLCBleDoge21hZ2F6aW5lSWQ6J2VudHJlcHJlbmV1cid9KVxuICAgICAqIHJldHVybnMgc3Vic2NyaXB0aW9uXG4gICAgICogXG4gICAgICovXG4gICAgZnVuY3Rpb24gc3Vic2NyaWJlKHB1YmxpY2F0aW9uTmFtZSwgc2NvcGUpIHtcbiAgICAgICAgcmV0dXJuIG5ldyBTdWJzY3JpcHRpb24ocHVibGljYXRpb25OYW1lLCBzY29wZSk7XG4gICAgfVxuXG5cblxuICAgIC8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vXG4gICAgLy8gSEVMUEVSU1xuXG4gICAgLy8gZXZlcnkgc3luYyBub3RpZmljYXRpb24gY29tZXMgdGhydSB0aGUgc2FtZSBldmVudCB0aGVuIGl0IGlzIGRpc3BhdGNoZXMgdG8gdGhlIHRhcmdldGVkIHN1YnNjcmlwdGlvbnMuXG4gICAgZnVuY3Rpb24gbGlzdGVuVG9TeW5jTm90aWZpY2F0aW9uKCkge1xuICAgICAgICAkc29ja2V0aW8ub24oJ1NZTkNfTk9XJywgZnVuY3Rpb24gKHN1Yk5vdGlmaWNhdGlvbiwgZm4pIHtcbiAgICAgICAgICAgIGNvbnNvbGUubG9nKCdTeW5jaW5nIHdpdGggc3Vic2NyaXB0aW9uIFtuYW1lOicgKyBzdWJOb3RpZmljYXRpb24ubmFtZSArICcsIGlkOicgKyBzdWJOb3RpZmljYXRpb24uc3Vic2NyaXB0aW9uSWQgKyAnICwgcGFyYW1zOicgKyBKU09OLnN0cmluZ2lmeShzdWJOb3RpZmljYXRpb24ucGFyYW1zKSArICddLiBSZWNvcmRzOicgKyBzdWJOb3RpZmljYXRpb24ucmVjb3Jkcy5sZW5ndGggKyAnWycgKyAoc3ViTm90aWZpY2F0aW9uLmRpZmYgPyAnRGlmZicgOiAnQWxsJykgKyAnXScpO1xuICAgICAgICAgICAgdmFyIGxpc3RlbmVycyA9IHB1YmxpY2F0aW9uTGlzdGVuZXJzW3N1Yk5vdGlmaWNhdGlvbi5uYW1lXTtcbiAgICAgICAgICAgIGlmIChsaXN0ZW5lcnMpIHtcbiAgICAgICAgICAgICAgICBmb3IgKHZhciBsaXN0ZW5lciBpbiBsaXN0ZW5lcnMpIHtcbiAgICAgICAgICAgICAgICAgICAgbGlzdGVuZXJzW2xpc3RlbmVyXShzdWJOb3RpZmljYXRpb24pO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGZuKCdTWU5DRUQnKTsgLy8gbGV0IGtub3cgdGhlIGJhY2tlbmQgdGhlIGNsaWVudCB3YXMgYWJsZSB0byBzeW5jLlxuICAgICAgICB9KTtcbiAgICB9O1xuXG5cbiAgICAvLyB0aGlzIGFsbG93cyBhIGRhdGFzZXQgdG8gbGlzdGVuIHRvIGFueSBTWU5DX05PVyBldmVudC4uYW5kIGlmIHRoZSBub3RpZmljYXRpb24gaXMgYWJvdXQgaXRzIGRhdGEuXG4gICAgZnVuY3Rpb24gYWRkUHVibGljYXRpb25MaXN0ZW5lcihzdHJlYW1OYW1lLCBjYWxsYmFjaykge1xuICAgICAgICB2YXIgdWlkID0gcHVibGljYXRpb25MaXN0ZW5lckNvdW50Kys7XG4gICAgICAgIHZhciBsaXN0ZW5lcnMgPSBwdWJsaWNhdGlvbkxpc3RlbmVyc1tzdHJlYW1OYW1lXTtcbiAgICAgICAgaWYgKCFsaXN0ZW5lcnMpIHtcbiAgICAgICAgICAgIHB1YmxpY2F0aW9uTGlzdGVuZXJzW3N0cmVhbU5hbWVdID0gbGlzdGVuZXJzID0ge307XG4gICAgICAgIH1cbiAgICAgICAgbGlzdGVuZXJzW3VpZF0gPSBjYWxsYmFjaztcblxuICAgICAgICByZXR1cm4gZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgZGVsZXRlIGxpc3RlbmVyc1t1aWRdO1xuICAgICAgICB9XG4gICAgfVxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgIC8vIFN1YnNjcmlwdGlvbiBvYmplY3RcbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAvKipcbiAgICAgKiBhIHN1YnNjcmlwdGlvbiBzeW5jaHJvbml6ZXMgd2l0aCB0aGUgYmFja2VuZCBmb3IgYW55IGJhY2tlbmQgZGF0YSBjaGFuZ2UgYW5kIG1ha2VzIHRoYXQgZGF0YSBhdmFpbGFibGUgdG8gYSBjb250cm9sbGVyLlxuICAgICAqIFxuICAgICAqICBXaGVuIGNsaWVudCBzdWJzY3JpYmVzIHRvIGFuIHN5bmNyb25pemVkIGFwaSwgYW55IGRhdGEgY2hhbmdlIHRoYXQgaW1wYWN0cyB0aGUgYXBpIHJlc3VsdCBXSUxMIGJlIFBVU0hlZCB0byB0aGUgY2xpZW50LlxuICAgICAqIElmIHRoZSBjbGllbnQgZG9lcyBOT1Qgc3Vic2NyaWJlIG9yIHN0b3Agc3Vic2NyaWJlLCBpdCB3aWxsIG5vIGxvbmdlciByZWNlaXZlIHRoZSBQVVNILiBcbiAgICAgKiAgICBcbiAgICAgKiBpZiB0aGUgY29ubmVjdGlvbiBpcyBsb3N0IGZvciBhIHNob3J0IHRpbWUgKGR1cmF0aW9uIGRlZmluZWQgb24gc2VydmVyLXNpZGUpLCB0aGUgc2VydmVyIHF1ZXVlcyB0aGUgY2hhbmdlcyBpZiBhbnkuIFxuICAgICAqIFdoZW4gdGhlIGNvbm5lY3Rpb24gcmV0dXJucywgdGhlIG1pc3NpbmcgZGF0YSBhdXRvbWF0aWNhbGx5ICB3aWxsIGJlIFBVU0hlZCB0byB0aGUgc3Vic2NyaWJpbmcgY2xpZW50LlxuICAgICAqIGlmIHRoZSBjb25uZWN0aW9uIGlzIGxvc3QgZm9yIGEgbG9uZyB0aW1lIChkdXJhdGlvbiBkZWZpbmVkIG9uIHRoZSBzZXJ2ZXIpLCB0aGUgc2VydmVyIHdpbGwgZGVzdHJveSB0aGUgc3Vic2NyaXB0aW9uLiBUbyBzaW1wbGlmeSwgdGhlIGNsaWVudCB3aWxsIHJlc3Vic2NyaWJlIGF0IGl0cyByZWNvbm5lY3Rpb24gYW5kIGdldCBhbGwgZGF0YS5cbiAgICAgKiBcbiAgICAgKiBzdWJzY3JpcHRpb24gb2JqZWN0IHByb3ZpZGVzIDMgY2FsbGJhY2tzIChhZGQsdXBkYXRlLCBkZWwpIHdoaWNoIGFyZSBjYWxsZWQgZHVyaW5nIHN5bmNocm9uaXphdGlvbi5cbiAgICAgKiAgICAgIFxuICAgICAqIFNjb3BlIHdpbGwgYWxsb3cgdGhlIHN1YnNjcmlwdGlvbiBzdG9wIHN5bmNocm9uaXppbmcgYW5kIGNhbmNlbCByZWdpc3RyYXRpb24gd2hlbiBpdCBpcyBkZXN0cm95ZWQuIFxuICAgICAqICBcbiAgICAgKiBDb25zdHJ1Y3RvcjpcbiAgICAgKiBcbiAgICAgKiBAcGFyYW0gcHVibGljYXRpb24sIHRoZSBwdWJsaWNhdGlvbiBtdXN0IGV4aXN0IG9uIHRoZSBzZXJ2ZXIgc2lkZVxuICAgICAqIEBwYXJhbSBzY29wZSwgYnkgZGVmYXVsdCAkcm9vdFNjb3BlLCBidXQgY2FuIGJlIG1vZGlmaWVkIGxhdGVyIG9uIHdpdGggYXR0YWNoIG1ldGhvZC5cbiAgICAgKi9cblxuICAgIGZ1bmN0aW9uIFN1YnNjcmlwdGlvbihwdWJsaWNhdGlvbiwgc2NvcGUpIHtcbiAgICAgICAgdmFyIHN1YnNjcmlwdGlvbklkLCBtYXhSZXZpc2lvbiA9IDAsIHRpbWVzdGFtcEZpZWxkLCBpc1N5bmNpbmdPbiA9IGZhbHNlLCBpc1NpbmdsZSwgdXBkYXRlRGF0YVN0b3JhZ2UsIGNhY2hlLCBpc0luaXRpYWxQdXNoQ29tcGxldGVkLCBkZWZlcnJlZEluaXRpYWxpemF0aW9uO1xuICAgICAgICB2YXIgb25SZWFkeU9mZiwgZm9ybWF0UmVjb3JkO1xuICAgICAgICB2YXIgcmVjb25uZWN0T2ZmLCBwdWJsaWNhdGlvbkxpc3RlbmVyT2ZmLCBkZXN0cm95T2ZmO1xuICAgICAgICB2YXIgb2JqZWN0Q2xhc3M7XG5cbiAgICAgICAgdmFyIHNEcyA9IHRoaXM7XG4gICAgICAgIHZhciBzdWJQYXJhbXMgPSB7fTtcbiAgICAgICAgdmFyIHJlY29yZFN0YXRlcyA9IHt9O1xuICAgICAgICB2YXIgaW5uZXJTY29wZTsvLz0gJHJvb3RTY29wZS4kbmV3KHRydWUpO1xuICAgICAgICB2YXIgc3luY0xpc3RlbmVyID0gbmV3IFN5bmNMaXN0ZW5lcigpO1xuXG4gICAgICAgIHRoaXMucmVhZHkgPSBmYWxzZTtcbiAgICAgICAgdGhpcy5zeW5jT24gPSBzeW5jT247XG4gICAgICAgIHRoaXMuc3luY09mZiA9IHN5bmNPZmY7XG4gICAgICAgIHRoaXMuc2V0T25SZWFkeSA9IHNldE9uUmVhZHk7XG5cbiAgICAgICAgdGhpcy5vblJlYWR5ID0gb25SZWFkeTtcbiAgICAgICAgdGhpcy5vblVwZGF0ZSA9IG9uVXBkYXRlO1xuICAgICAgICB0aGlzLm9uQWRkID0gb25BZGQ7XG4gICAgICAgIHRoaXMub25SZW1vdmUgPSBvblJlbW92ZTtcblxuICAgICAgICB0aGlzLmdldERhdGEgPSBnZXREYXRhO1xuICAgICAgICB0aGlzLnNldFBhcmFtZXRlcnMgPSBzZXRQYXJhbWV0ZXJzO1xuXG4gICAgICAgIHRoaXMud2FpdEZvckRhdGFSZWFkeSA9IHdhaXRGb3JEYXRhUmVhZHk7XG4gICAgICAgIHRoaXMud2FpdEZvclN1YnNjcmlwdGlvblJlYWR5ID0gd2FpdEZvclN1YnNjcmlwdGlvblJlYWR5O1xuXG4gICAgICAgIHRoaXMuc2V0Rm9yY2UgPSBzZXRGb3JjZTtcbiAgICAgICAgdGhpcy5pc1N5bmNpbmcgPSBpc1N5bmNpbmc7XG4gICAgICAgIHRoaXMuaXNSZWFkeSA9IGlzUmVhZHk7XG5cbiAgICAgICAgdGhpcy5zZXRTaW5nbGUgPSBzZXRTaW5nbGU7XG5cbiAgICAgICAgdGhpcy5zZXRPYmplY3RDbGFzcyA9IHNldE9iamVjdENsYXNzO1xuICAgICAgICB0aGlzLmdldE9iamVjdENsYXNzID0gZ2V0T2JqZWN0Q2xhc3M7XG5cbiAgICAgICAgdGhpcy5hdHRhY2ggPSBhdHRhY2g7XG4gICAgICAgIHRoaXMuZGVzdHJveSA9IGRlc3Ryb3k7XG5cbiAgICAgICAgdGhpcy5pc0V4aXN0aW5nU3RhdGVGb3IgPSBpc0V4aXN0aW5nU3RhdGVGb3I7IC8vIGZvciB0ZXN0aW5nIHB1cnBvc2VzXG5cbiAgICAgICAgc2V0U2luZ2xlKGZhbHNlKTtcblxuICAgICAgICAvLyB0aGlzIHdpbGwgbWFrZSBzdXJlIHRoYXQgdGhlIHN1YnNjcmlwdGlvbiBpcyByZWxlYXNlZCBmcm9tIHNlcnZlcnMgaWYgdGhlIGFwcCBjbG9zZXMgKGNsb3NlIGJyb3dzZXIsIHJlZnJlc2guLi4pXG4gICAgICAgIGF0dGFjaChzY29wZSB8fCAkcm9vdFNjb3BlKTtcblxuICAgICAgICAvLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vXG5cbiAgICAgICAgZnVuY3Rpb24gZGVzdHJveSgpIHtcbiAgICAgICAgICAgIHN5bmNPZmYoKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8qKiB0aGlzIHdpbGwgYmUgY2FsbGVkIHdoZW4gZGF0YSBpcyBhdmFpbGFibGUgXG4gICAgICAgICAqICBpdCBtZWFucyByaWdodCBhZnRlciBlYWNoIHN5bmMhXG4gICAgICAgICAqIFxuICAgICAgICAgKiBcbiAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gc2V0T25SZWFkeShjYWxsYmFjaykge1xuICAgICAgICAgICAgaWYgKG9uUmVhZHlPZmYpIHtcbiAgICAgICAgICAgICAgICBvblJlYWR5T2ZmKCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBvblJlYWR5T2ZmID0gb25SZWFkeShjYWxsYmFjayk7XG4gICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICB9XG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqIGZvcmNlIHJlc3luY2luZyBmcm9tIHNjcmF0Y2ggZXZlbiBpZiB0aGUgcGFyYW1ldGVycyBoYXZlIG5vdCBjaGFuZ2VkXG4gICAgICAgICAqIFxuICAgICAgICAgKiBpZiBvdXRzaWRlIGNvZGUgaGFzIG1vZGlmaWVkIHRoZSBkYXRhIGFuZCB5b3UgbmVlZCB0byByb2xsYmFjaywgeW91IGNvdWxkIGNvbnNpZGVyIGZvcmNpbmcgYSByZWZyZXNoIHdpdGggdGhpcy4gQmV0dGVyIHNvbHV0aW9uIHNob3VsZCBiZSBmb3VuZCB0aGFuIHRoYXQuXG4gICAgICAgICAqIFxuICAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gc2V0Rm9yY2UodmFsdWUpIHtcbiAgICAgICAgICAgIGlmICh2YWx1ZSkge1xuICAgICAgICAgICAgICAgIC8vIHF1aWNrIGhhY2sgdG8gZm9yY2UgdG8gcmVsb2FkLi4ucmVjb2RlIGxhdGVyLlxuICAgICAgICAgICAgICAgIHNEcy5zeW5jT2ZmKCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICB9XG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqIFRoZSBmb2xsb3dpbmcgb2JqZWN0IHdpbGwgYmUgYnVpbHQgdXBvbiBlYWNoIHJlY29yZCByZWNlaXZlZCBmcm9tIHRoZSBiYWNrZW5kXG4gICAgICAgICAqIFxuICAgICAgICAgKiBUaGlzIGNhbm5vdCBiZSBtb2RpZmllZCBhZnRlciB0aGUgc3luYyBoYXMgc3RhcnRlZC5cbiAgICAgICAgICogXG4gICAgICAgICAqIEBwYXJhbSBjbGFzc1ZhbHVlXG4gICAgICAgICAqL1xuICAgICAgICBmdW5jdGlvbiBzZXRPYmplY3RDbGFzcyhjbGFzc1ZhbHVlKSB7XG4gICAgICAgICAgICBpZiAoZGVmZXJyZWRJbml0aWFsaXphdGlvbikge1xuICAgICAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIG9iamVjdENsYXNzID0gY2xhc3NWYWx1ZTtcbiAgICAgICAgICAgIGZvcm1hdFJlY29yZCA9IGZ1bmN0aW9uIChyZWNvcmQpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gbmV3IG9iamVjdENsYXNzKHJlY29yZCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBzZXRTaW5nbGUoaXNTaW5nbGUpO1xuICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIGdldE9iamVjdENsYXNzKCkge1xuICAgICAgICAgICAgcmV0dXJuIG9iamVjdENsYXNzO1xuICAgICAgICB9XG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqIHRoaXMgZnVuY3Rpb24gc3RhcnRzIHRoZSBzeW5jaW5nLlxuICAgICAgICAgKiBPbmx5IHB1YmxpY2F0aW9uIHB1c2hpbmcgZGF0YSBtYXRjaGluZyBvdXIgZmV0Y2hpbmcgcGFyYW1zIHdpbGwgYmUgcmVjZWl2ZWQuXG4gICAgICAgICAqIFxuICAgICAgICAgKiBleDogZm9yIGEgcHVibGljYXRpb24gbmFtZWQgXCJtYWdhemluZXMuc3luY1wiLCBpZiBmZXRjaGluZyBwYXJhbXMgZXF1YWxsZWQge21hZ2F6aW5OYW1lOidjYXJzJ30sIHRoZSBtYWdhemluZSBjYXJzIGRhdGEgd291bGQgYmUgcmVjZWl2ZWQgYnkgdGhpcyBzdWJzY3JpcHRpb24uXG4gICAgICAgICAqIFxuICAgICAgICAgKiBAcGFyYW0gZmV0Y2hpbmdQYXJhbXNcbiAgICAgICAgICogQHBhcmFtIG9wdGlvbnNcbiAgICAgICAgICogXG4gICAgICAgICAqIEByZXR1cm5zIGEgcHJvbWlzZSB0aGF0IHJlc29sdmVzIHdoZW4gZGF0YSBpcyBhcnJpdmVkLlxuICAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gc2V0UGFyYW1ldGVycyhmZXRjaGluZ1BhcmFtcywgb3B0aW9ucykge1xuICAgICAgICAgICAgaWYgKGlzU3luY2luZ09uICYmIGFuZ3VsYXIuZXF1YWxzKGZldGNoaW5nUGFyYW1zLCBzdWJQYXJhbXMpKSB7XG4gICAgICAgICAgICAgICAgLy8gaWYgdGhlIHBhcmFtcyBoYXZlIG5vdCBjaGFuZ2VkLCBqdXN0IHJldHVybnMgd2l0aCBjdXJyZW50IGRhdGEuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHNEczsgLy8kcS5yZXNvbHZlKGdldERhdGEoKSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBzeW5jT2ZmKCk7XG4gICAgICAgICAgICBpZiAoIWlzU2luZ2xlKSB7XG4gICAgICAgICAgICAgICAgY2FjaGUubGVuZ3RoID0gMDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIG1heFJldmlzaW9uID0gMDtcbiAgICAgICAgICAgIHN1YlBhcmFtcyA9IGZldGNoaW5nUGFyYW1zIHx8IHt9O1xuICAgICAgICAgICAgb3B0aW9ucyA9IG9wdGlvbnMgfHwge307XG4gICAgICAgICAgICBpZiAoYW5ndWxhci5pc0RlZmluZWQob3B0aW9ucy5zaW5nbGUpKSB7XG4gICAgICAgICAgICAgICAgc2V0U2luZ2xlKG9wdGlvbnMuc2luZ2xlKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHN5bmNPbigpO1xuICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIHdhaXQgZm9yIHRoZSBpbml0aWFsIGZldGNoIHRvIGNvbXBsZXRlIHRoZW4gcmV0dXJucyB0aGlzIHN1YnNjcmlwdGlvblxuICAgICAgICBmdW5jdGlvbiB3YWl0Rm9yU3Vic2NyaXB0aW9uUmVhZHkoKSB7XG4gICAgICAgICAgICByZXR1cm4gZGVmZXJyZWRJbml0aWFsaXphdGlvbi5wcm9taXNlLnRoZW4oZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIHdhaXQgZm9yIHRoZSBpbml0aWFsIGZldGNoIHRvIGNvbXBsZXRlIHRoZW4gcmV0dXJucyB0aGUgZGF0YVxuICAgICAgICBmdW5jdGlvbiB3YWl0Rm9yRGF0YVJlYWR5KCkge1xuICAgICAgICAgICAgcmV0dXJuIGRlZmVycmVkSW5pdGlhbGl6YXRpb24ucHJvbWlzZTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIGRvZXMgdGhlIGRhdGFzZXQgcmV0dXJucyBvbmx5IG9uZSBvYmplY3Q/IG5vdCBhbiBhcnJheT9cbiAgICAgICAgZnVuY3Rpb24gc2V0U2luZ2xlKHZhbHVlKSB7XG4gICAgICAgICAgICBpZiAoZGVmZXJyZWRJbml0aWFsaXphdGlvbikge1xuICAgICAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlzU2luZ2xlID0gdmFsdWU7XG4gICAgICAgICAgICBpZiAodmFsdWUpIHtcbiAgICAgICAgICAgICAgICB1cGRhdGVEYXRhU3RvcmFnZSA9IHVwZGF0ZVN5bmNlZE9iamVjdDtcbiAgICAgICAgICAgICAgICBjYWNoZSA9IG9iamVjdENsYXNzID8gbmV3IG9iamVjdENsYXNzKHt9KSA6IHt9O1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB1cGRhdGVEYXRhU3RvcmFnZSA9IHVwZGF0ZVN5bmNlZEFycmF5O1xuICAgICAgICAgICAgICAgIGNhY2hlID0gW107XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gcmV0dXJucyB0aGUgb2JqZWN0IG9yIGFycmF5IGluIHN5bmNcbiAgICAgICAgZnVuY3Rpb24gZ2V0RGF0YSgpIHtcbiAgICAgICAgICAgIHJldHVybiBjYWNoZTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiB0aGUgZGF0YXNldCB3aWxsIHN0YXJ0IGxpc3RlbmluZyB0byB0aGUgZGF0YXN0cmVhbSBcbiAgICAgICAgICogXG4gICAgICAgICAqIE5vdGUgRHVyaW5nIHRoZSBzeW5jLCBpdCB3aWxsIGFsc28gY2FsbCB0aGUgb3B0aW9uYWwgY2FsbGJhY2tzIC0gYWZ0ZXIgcHJvY2Vzc2luZyBFQUNIIHJlY29yZCByZWNlaXZlZC5cbiAgICAgICAgICogXG4gICAgICAgICAqIEByZXR1cm5zIGEgcHJvbWlzZSB0aGF0IHdpbGwgYmUgcmVzb2x2ZWQgd2hlbiB0aGUgZGF0YSBpcyByZWFkeS5cbiAgICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIHN5bmNPbigpIHtcbiAgICAgICAgICAgIGlmIChpc1N5bmNpbmdPbikge1xuICAgICAgICAgICAgICAgIHJldHVybiBkZWZlcnJlZEluaXRpYWxpemF0aW9uLnByb21pc2U7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBkZWZlcnJlZEluaXRpYWxpemF0aW9uID0gJHEuZGVmZXIoKTtcbiAgICAgICAgICAgIGlzSW5pdGlhbFB1c2hDb21wbGV0ZWQgPSBmYWxzZTtcbiAgICAgICAgICAgIGNvbnNvbGUubG9nKCdTeW5jICcgKyBwdWJsaWNhdGlvbiArICcgb24uIFBhcmFtczonICsgSlNPTi5zdHJpbmdpZnkoc3ViUGFyYW1zKSk7XG4gICAgICAgICAgICBpc1N5bmNpbmdPbiA9IHRydWU7XG4gICAgICAgICAgICByZWdpc3RlclN1YnNjcmlwdGlvbigpO1xuICAgICAgICAgICAgcmVhZHlGb3JMaXN0ZW5pbmcoKTtcbiAgICAgICAgICAgIHJldHVybiBkZWZlcnJlZEluaXRpYWxpemF0aW9uLnByb21pc2U7XG4gICAgICAgIH1cblxuICAgICAgICAvKipcbiAgICAgICAgICogdGhlIGRhdGFzZXQgaXMgbm8gbG9uZ2VyIGxpc3RlbmluZyBhbmQgd2lsbCBub3QgY2FsbCBhbnkgY2FsbGJhY2tcbiAgICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIHN5bmNPZmYoKSB7XG4gICAgICAgICAgICBpZiAoZGVmZXJyZWRJbml0aWFsaXphdGlvbikge1xuICAgICAgICAgICAgICAgIC8vIGlmIHRoZXJlIGlzIGNvZGUgd2FpdGluZyBvbiB0aGlzIHByb21pc2UuLiBleCAobG9hZCBpbiByZXNvbHZlKVxuICAgICAgICAgICAgICAgIGRlZmVycmVkSW5pdGlhbGl6YXRpb24ucmVzb2x2ZShnZXREYXRhKCkpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKGlzU3luY2luZ09uKSB7XG4gICAgICAgICAgICAgICAgdW5yZWdpc3RlclN1YnNjcmlwdGlvbigpO1xuICAgICAgICAgICAgICAgIGlzU3luY2luZ09uID0gZmFsc2U7XG5cbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZygnU3luYyAnICsgcHVibGljYXRpb24gKyAnIG9mZi4gUGFyYW1zOicgKyBKU09OLnN0cmluZ2lmeShzdWJQYXJhbXMpKTtcbiAgICAgICAgICAgICAgICBpZiAocHVibGljYXRpb25MaXN0ZW5lck9mZikge1xuICAgICAgICAgICAgICAgICAgICBwdWJsaWNhdGlvbkxpc3RlbmVyT2ZmKCk7XG4gICAgICAgICAgICAgICAgICAgIHB1YmxpY2F0aW9uTGlzdGVuZXJPZmYgPSBudWxsO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBpZiAocmVjb25uZWN0T2ZmKSB7XG4gICAgICAgICAgICAgICAgICAgIHJlY29ubmVjdE9mZigpO1xuICAgICAgICAgICAgICAgICAgICByZWNvbm5lY3RPZmYgPSBudWxsO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIGlzU3luY2luZygpIHtcbiAgICAgICAgICAgIHJldHVybiBpc1N5bmNpbmdPbjtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIHJlYWR5Rm9yTGlzdGVuaW5nKCkge1xuICAgICAgICAgICAgaWYgKCFwdWJsaWNhdGlvbkxpc3RlbmVyT2ZmKSB7XG4gICAgICAgICAgICAgICAgbGlzdGVuRm9yUmVjb25uZWN0aW9uVG9SZXN5bmMoKTtcbiAgICAgICAgICAgICAgICBsaXN0ZW5Ub1B1YmxpY2F0aW9uKCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICAvKipcbiAgICAgICAgICogIEJ5IGRlZmF1bHQgdGhlIHJvb3RzY29wZSBpcyBhdHRhY2hlZCBpZiBubyBzY29wZSB3YXMgcHJvdmlkZWQuIEJ1dCBpdCBpcyBwb3NzaWJsZSB0byByZS1hdHRhY2ggaXQgdG8gYSBkaWZmZXJlbnQgc2NvcGUuIGlmIHRoZSBzdWJzY3JpcHRpb24gZGVwZW5kcyBvbiBhIGNvbnRyb2xsZXIuXG4gICAgICAgICAqXG4gICAgICAgICAqICBEbyBub3QgYXR0YWNoIGFmdGVyIGl0IGhhcyBzeW5jZWQuXG4gICAgICAgICAqL1xuICAgICAgICBmdW5jdGlvbiBhdHRhY2gobmV3U2NvcGUpIHtcbiAgICAgICAgICAgIGlmIChkZWZlcnJlZEluaXRpYWxpemF0aW9uKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChkZXN0cm95T2ZmKSB7XG4gICAgICAgICAgICAgICAgZGVzdHJveU9mZigpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaW5uZXJTY29wZSA9IG5ld1Njb3BlO1xuICAgICAgICAgICAgZGVzdHJveU9mZiA9IGlubmVyU2NvcGUuJG9uKCckZGVzdHJveScsIGRlc3Ryb3kpO1xuXG4gICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gbGlzdGVuRm9yUmVjb25uZWN0aW9uVG9SZXN5bmMobGlzdGVuTm93KSB7XG4gICAgICAgICAgICAvLyBnaXZlIGEgY2hhbmNlIHRvIGNvbm5lY3QgYmVmb3JlIGxpc3RlbmluZyB0byByZWNvbm5lY3Rpb24uLi4gQFRPRE8gc2hvdWxkIGhhdmUgdXNlcl9yZWNvbm5lY3RlZF9ldmVudFxuICAgICAgICAgICAgc2V0VGltZW91dChmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgcmVjb25uZWN0T2ZmID0gaW5uZXJTY29wZS4kb24oJ3VzZXJfY29ubmVjdGVkJywgZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgICAgICBjb25zb2xlLmRlYnVnKCdSZXN5bmNpbmcgYWZ0ZXIgbmV0d29yayBsb3NzIHRvICcgKyBwdWJsaWNhdGlvbik7XG4gICAgICAgICAgICAgICAgICAgIC8vIG5vdGUgdGhlIGJhY2tlbmQgbWlnaHQgcmV0dXJuIGEgbmV3IHN1YnNjcmlwdGlvbiBpZiB0aGUgY2xpZW50IHRvb2sgdG9vIG11Y2ggdGltZSB0byByZWNvbm5lY3QuXG4gICAgICAgICAgICAgICAgICAgIHJlZ2lzdGVyU3Vic2NyaXB0aW9uKCk7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9LCBsaXN0ZW5Ob3cgPyAwIDogMjAwMCk7XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiByZWdpc3RlclN1YnNjcmlwdGlvbigpIHtcbiAgICAgICAgICAgICRzb2NrZXRpby5mZXRjaCgnc3luYy5zdWJzY3JpYmUnLCB7XG4gICAgICAgICAgICAgICAgdmVyc2lvbjogU1lOQ19WRVJTSU9OLFxuICAgICAgICAgICAgICAgIGlkOiBzdWJzY3JpcHRpb25JZCwgLy8gdG8gdHJ5IHRvIHJlLXVzZSBleGlzdGluZyBzdWJjcmlwdGlvblxuICAgICAgICAgICAgICAgIHB1YmxpY2F0aW9uOiBwdWJsaWNhdGlvbixcbiAgICAgICAgICAgICAgICBwYXJhbXM6IHN1YlBhcmFtc1xuICAgICAgICAgICAgfSkudGhlbihmdW5jdGlvbiAoc3ViSWQpIHtcbiAgICAgICAgICAgICAgICBzdWJzY3JpcHRpb25JZCA9IHN1YklkO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiB1bnJlZ2lzdGVyU3Vic2NyaXB0aW9uKCkge1xuICAgICAgICAgICAgaWYgKHN1YnNjcmlwdGlvbklkKSB7XG4gICAgICAgICAgICAgICAgJHNvY2tldGlvLmZldGNoKCdzeW5jLnVuc3Vic2NyaWJlJywge1xuICAgICAgICAgICAgICAgICAgICB2ZXJzaW9uOiBTWU5DX1ZFUlNJT04sXG4gICAgICAgICAgICAgICAgICAgIGlkOiBzdWJzY3JpcHRpb25JZFxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIHN1YnNjcmlwdGlvbklkID0gbnVsbDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIGxpc3RlblRvUHVibGljYXRpb24oKSB7XG4gICAgICAgICAgICAvLyBjYW5ub3Qgb25seSBsaXN0ZW4gdG8gc3Vic2NyaXB0aW9uSWQgeWV0Li4uYmVjYXVzZSB0aGUgcmVnaXN0cmF0aW9uIG1pZ2h0IGhhdmUgYW5zd2VyIHByb3ZpZGVkIGl0cyBpZCB5ZXQuLi5idXQgc3RhcnRlZCBicm9hZGNhc3RpbmcgY2hhbmdlcy4uLkBUT0RPIGNhbiBiZSBpbXByb3ZlZC4uLlxuICAgICAgICAgICAgcHVibGljYXRpb25MaXN0ZW5lck9mZiA9IGFkZFB1YmxpY2F0aW9uTGlzdGVuZXIocHVibGljYXRpb24sIGZ1bmN0aW9uIChiYXRjaCkge1xuICAgICAgICAgICAgICAgIGlmIChzdWJzY3JpcHRpb25JZCA9PT0gYmF0Y2guc3Vic2NyaXB0aW9uSWQgfHwgKCFzdWJzY3JpcHRpb25JZCAmJiBjaGVja0RhdGFTZXRQYXJhbXNJZk1hdGNoaW5nQmF0Y2hQYXJhbXMoYmF0Y2gucGFyYW1zKSkpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFiYXRjaC5kaWZmKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBDbGVhciB0aGUgY2FjaGUgdG8gcmVidWlsZCBpdCBpZiBhbGwgZGF0YSB3YXMgcmVjZWl2ZWQuXG4gICAgICAgICAgICAgICAgICAgICAgICByZWNvcmRTdGF0ZXMgPSB7fTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghaXNTaW5nbGUpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYWNoZS5sZW5ndGggPSAwO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIGFwcGx5Q2hhbmdlcyhiYXRjaC5yZWNvcmRzKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFpc0luaXRpYWxQdXNoQ29tcGxldGVkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpc0luaXRpYWxQdXNoQ29tcGxldGVkID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGRlZmVycmVkSW5pdGlhbGl6YXRpb24ucmVzb2x2ZShnZXREYXRhKCkpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICAvKipcbiAgICAgICAgKiBpZiB0aGUgcGFyYW1zIG9mIHRoZSBkYXRhc2V0IG1hdGNoZXMgdGhlIG5vdGlmaWNhdGlvbiwgaXQgbWVhbnMgdGhlIGRhdGEgbmVlZHMgdG8gYmUgY29sbGVjdCB0byB1cGRhdGUgYXJyYXkuXG4gICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIGNoZWNrRGF0YVNldFBhcmFtc0lmTWF0Y2hpbmdCYXRjaFBhcmFtcyhiYXRjaFBhcmFtcykge1xuICAgICAgICAgICAgLy8gaWYgKHBhcmFtcy5sZW5ndGggIT0gc3RyZWFtUGFyYW1zLmxlbmd0aCkge1xuICAgICAgICAgICAgLy8gICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIC8vIH1cbiAgICAgICAgICAgIGlmICghc3ViUGFyYW1zIHx8IE9iamVjdC5rZXlzKHN1YlBhcmFtcykubGVuZ3RoID09IDApIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdmFyIG1hdGNoaW5nID0gdHJ1ZTtcbiAgICAgICAgICAgIGZvciAodmFyIHBhcmFtIGluIGJhdGNoUGFyYW1zKSB7XG4gICAgICAgICAgICAgICAgLy8gYXJlIG90aGVyIHBhcmFtcyBtYXRjaGluZz9cbiAgICAgICAgICAgICAgICAvLyBleDogd2UgbWlnaHQgaGF2ZSByZWNlaXZlIGEgbm90aWZpY2F0aW9uIGFib3V0IHRhc2tJZD0yMCBidXQgdGhpcyBzdWJzY3JpcHRpb24gYXJlIG9ubHkgaW50ZXJlc3RlZCBhYm91dCB0YXNrSWQtM1xuICAgICAgICAgICAgICAgIGlmIChiYXRjaFBhcmFtc1twYXJhbV0gIT09IHN1YlBhcmFtc1twYXJhbV0pIHtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIG1hdGNoaW5nO1xuXG4gICAgICAgIH1cblxuICAgICAgICAvLyBmZXRjaCBhbGwgdGhlIG1pc3NpbmcgcmVjb3JkcywgYW5kIGFjdGl2YXRlIHRoZSBjYWxsIGJhY2tzIChhZGQsdXBkYXRlLHJlbW92ZSkgYWNjb3JkaW5nbHkgaWYgdGhlcmUgaXMgc29tZXRoaW5nIHRoYXQgaXMgbmV3IG9yIG5vdCBhbHJlYWR5IGluIHN5bmMuXG4gICAgICAgIGZ1bmN0aW9uIGFwcGx5Q2hhbmdlcyhyZWNvcmRzKSB7XG4gICAgICAgICAgICB2YXIgbmV3RGF0YUFycmF5ID0gW107XG4gICAgICAgICAgICB2YXIgbmV3RGF0YTtcbiAgICAgICAgICAgIHNEcy5yZWFkeSA9IGZhbHNlO1xuICAgICAgICAgICAgcmVjb3Jkcy5mb3JFYWNoKGZ1bmN0aW9uIChyZWNvcmQpIHtcbiAgICAgICAgICAgICAgICAvLyAgICAgICAgICAgICAgICAgICBjb25zb2xlLmxvZygnRGF0YXN5bmMgWycgKyBkYXRhU3RyZWFtTmFtZSArICddIHJlY2VpdmVkOicgK0pTT04uc3RyaW5naWZ5KHJlY29yZCkpOy8vKyByZWNvcmQuaWQpO1xuICAgICAgICAgICAgICAgIGlmIChyZWNvcmQucmVtb3ZlKSB7XG4gICAgICAgICAgICAgICAgICAgIHJlbW92ZVJlY29yZChyZWNvcmQpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAocmVjb3JkU3RhdGVzW3JlY29yZC5pZF0pIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gaWYgdGhlIHJlY29yZCBpcyBhbHJlYWR5IHByZXNlbnQgaW4gdGhlIGNhY2hlLi4uc28gaXQgaXMgbWlnaHRiZSBhbiB1cGRhdGUuLlxuICAgICAgICAgICAgICAgICAgICBuZXdEYXRhID0gdXBkYXRlUmVjb3JkKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgbmV3RGF0YSA9IGFkZFJlY29yZChyZWNvcmQpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBpZiAobmV3RGF0YSkge1xuICAgICAgICAgICAgICAgICAgICBuZXdEYXRhQXJyYXkucHVzaChuZXdEYXRhKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIHNEcy5yZWFkeSA9IHRydWU7XG4gICAgICAgICAgICBpZiAoaXNTaW5nbGUpIHtcbiAgICAgICAgICAgICAgICBzeW5jTGlzdGVuZXIubm90aWZ5KCdyZWFkeScsIGdldERhdGEoKSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHN5bmNMaXN0ZW5lci5ub3RpZnkoJ3JlYWR5JywgZ2V0RGF0YSgpLCBuZXdEYXRhQXJyYXkpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqIEFsdGhvdWdoIG1vc3QgY2FzZXMgYXJlIGhhbmRsZWQgdXNpbmcgb25SZWFkeSwgdGhpcyB0ZWxscyB5b3UgdGhlIGN1cnJlbnQgZGF0YSBzdGF0ZS5cbiAgICAgICAgICogXG4gICAgICAgICAqIEByZXR1cm5zIGlmIHRydWUgaXMgYSBzeW5jIGhhcyBiZWVuIHByb2Nlc3NlZCBvdGhlcndpc2UgZmFsc2UgaWYgdGhlIGRhdGEgaXMgbm90IHJlYWR5LlxuICAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gaXNSZWFkeSgpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLnJlYWR5O1xuICAgICAgICB9XG4gICAgICAgIC8qKlxuICAgICAgICAgKiBcbiAgICAgICAgICogcmV0dXJucyBhIGZ1bmN0aW9uIHRvIHJlbW92ZSB0aGUgbGlzdGVuZXIuXG4gICAgICAgICAqL1xuICAgICAgICBmdW5jdGlvbiBvbkFkZChjYWxsYmFjaykge1xuICAgICAgICAgICAgcmV0dXJuIHN5bmNMaXN0ZW5lci5vbignYWRkJywgY2FsbGJhY2spO1xuICAgICAgICB9XG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqIFxuICAgICAgICAgKiByZXR1cm5zIGEgZnVuY3Rpb24gdG8gcmVtb3ZlIHRoZSBsaXN0ZW5lci5cbiAgICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIG9uVXBkYXRlKGNhbGxiYWNrKSB7XG4gICAgICAgICAgICByZXR1cm4gc3luY0xpc3RlbmVyLm9uKCd1cGRhdGUnLCBjYWxsYmFjayk7XG4gICAgICAgIH1cblxuICAgICAgICAvKipcbiAgICAgICAgICogXG4gICAgICAgICAqIHJldHVybnMgYSBmdW5jdGlvbiB0byByZW1vdmUgdGhlIGxpc3RlbmVyLlxuICAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gb25SZW1vdmUoY2FsbGJhY2spIHtcbiAgICAgICAgICAgIHJldHVybiBzeW5jTGlzdGVuZXIub24oJ3JlbW92ZScsIGNhbGxiYWNrKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiBcbiAgICAgICAgICogcmV0dXJucyBhIGZ1bmN0aW9uIHRvIHJlbW92ZSB0aGUgbGlzdGVuZXIuXG4gICAgICAgICAqL1xuICAgICAgICBmdW5jdGlvbiBvblJlYWR5KGNhbGxiYWNrKSB7XG4gICAgICAgICAgICByZXR1cm4gc3luY0xpc3RlbmVyLm9uKCdyZWFkeScsIGNhbGxiYWNrKTtcbiAgICAgICAgfVxuXG5cbiAgICAgICAgZnVuY3Rpb24gYWRkUmVjb3JkKHJlY29yZCkge1xuICAgICAgICAgICAgY29uc29sZS5kZWJ1ZygnU3luYyAtPiBJbnNlcnRlZCBOZXcgcmVjb3JkICMnICsgcmVjb3JkLmlkICsgJyBmb3Igc3Vic2NyaXB0aW9uIHRvICcgKyBwdWJsaWNhdGlvbik7Ly8gSlNPTi5zdHJpbmdpZnkocmVjb3JkKSk7XG4gICAgICAgICAgICBnZXRSZXZpc2lvbihyZWNvcmQpOyAvLyBqdXN0IG1ha2Ugc3VyZSB3ZSBjYW4gZ2V0IGEgcmV2aXNpb24gYmVmb3JlIHdlIGhhbmRsZSB0aGlzIHJlY29yZFxuICAgICAgICAgICAgdXBkYXRlRGF0YVN0b3JhZ2UoZm9ybWF0UmVjb3JkID8gZm9ybWF0UmVjb3JkKHJlY29yZCkgOiByZWNvcmQpO1xuICAgICAgICAgICAgc3luY0xpc3RlbmVyLm5vdGlmeSgnYWRkJywgcmVjb3JkKTtcbiAgICAgICAgICAgIHJldHVybiByZWNvcmQ7XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiB1cGRhdGVSZWNvcmQocmVjb3JkKSB7XG4gICAgICAgICAgICB2YXIgcHJldmlvdXMgPSByZWNvcmRTdGF0ZXNbcmVjb3JkLmlkXTtcbiAgICAgICAgICAgIGlmIChnZXRSZXZpc2lvbihyZWNvcmQpIDw9IGdldFJldmlzaW9uKHByZXZpb3VzKSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBudWxsO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc29sZS5kZWJ1ZygnU3luYyAtPiBVcGRhdGVkIHJlY29yZCAjJyArIHJlY29yZC5pZCArICcgZm9yIHN1YnNjcmlwdGlvbiB0byAnICsgcHVibGljYXRpb24pOy8vIEpTT04uc3RyaW5naWZ5KHJlY29yZCkpO1xuICAgICAgICAgICAgdXBkYXRlRGF0YVN0b3JhZ2UoZm9ybWF0UmVjb3JkID8gZm9ybWF0UmVjb3JkKHJlY29yZCkgOiByZWNvcmQpO1xuICAgICAgICAgICAgc3luY0xpc3RlbmVyLm5vdGlmeSgndXBkYXRlJywgcmVjb3JkKTtcbiAgICAgICAgICAgIHJldHVybiByZWNvcmQ7XG4gICAgICAgIH1cblxuXG4gICAgICAgIGZ1bmN0aW9uIHJlbW92ZVJlY29yZChyZWNvcmQpIHtcbiAgICAgICAgICAgIHZhciBwcmV2aW91cyA9IHJlY29yZFN0YXRlc1tyZWNvcmQuaWRdO1xuICAgICAgICAgICAgaWYgKCFwcmV2aW91cyB8fCBnZXRSZXZpc2lvbihyZWNvcmQpID4gZ2V0UmV2aXNpb24ocHJldmlvdXMpKSB7XG4gICAgICAgICAgICAgICAgY29uc29sZS5kZWJ1ZygnU3luYyAtPiBSZW1vdmVkICMnICsgcmVjb3JkLmlkICsgJyBmb3Igc3Vic2NyaXB0aW9uIHRvICcgKyBwdWJsaWNhdGlvbik7XG4gICAgICAgICAgICAgICAgLy8gV2UgY291bGQgaGF2ZSBmb3IgdGhlIHNhbWUgcmVjb3JkIGNvbnNlY3V0aXZlbHkgZmV0Y2hpbmcgaW4gdGhpcyBvcmRlcjpcbiAgICAgICAgICAgICAgICAvLyBkZWxldGUgaWQ6NCwgcmV2IDEwLCB0aGVuIGFkZCBpZDo0LCByZXYgOS4uLi4gYnkga2VlcGluZyB0cmFjayBvZiB3aGF0IHdhcyBkZWxldGVkLCB3ZSB3aWxsIG5vdCBhZGQgdGhlIHJlY29yZCBzaW5jZSBpdCB3YXMgZGVsZXRlZCB3aXRoIGEgbW9zdCByZWNlbnQgdGltZXN0YW1wLlxuICAgICAgICAgICAgICAgIHJlY29yZC5yZW1vdmVkID0gdHJ1ZTsgLy8gU28gd2Ugb25seSBmbGFnIGFzIHJlbW92ZWQsIGxhdGVyIG9uIHRoZSBnYXJiYWdlIGNvbGxlY3RvciB3aWxsIGdldCByaWQgb2YgaXQuICAgICAgICAgXG4gICAgICAgICAgICAgICAgdXBkYXRlRGF0YVN0b3JhZ2UocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAvLyBpZiB0aGVyZSBpcyBubyBwcmV2aW91cyByZWNvcmQgd2UgZG8gbm90IG5lZWQgdG8gcmVtb3ZlZCBhbnkgdGhpbmcgZnJvbSBvdXIgc3RvcmFnZS4gICAgIFxuICAgICAgICAgICAgICAgIGlmIChwcmV2aW91cykge1xuICAgICAgICAgICAgICAgICAgICBzeW5jTGlzdGVuZXIubm90aWZ5KCdyZW1vdmUnLCByZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICBkaXNwb3NlKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGZ1bmN0aW9uIGRpc3Bvc2UocmVjb3JkKSB7XG4gICAgICAgICAgICAkc3luY0dhcmJhZ2VDb2xsZWN0b3IuZGlzcG9zZShmdW5jdGlvbiBjb2xsZWN0KCkge1xuICAgICAgICAgICAgICAgIHZhciBleGlzdGluZ1JlY29yZCA9IHJlY29yZFN0YXRlc1tyZWNvcmQuaWRdO1xuICAgICAgICAgICAgICAgIGlmIChleGlzdGluZ1JlY29yZCAmJiByZWNvcmQucmV2aXNpb24gPj0gZXhpc3RpbmdSZWNvcmQucmV2aXNpb25cbiAgICAgICAgICAgICAgICApIHtcbiAgICAgICAgICAgICAgICAgICAgLy9jb25zb2xlLmRlYnVnKCdDb2xsZWN0IE5vdzonICsgSlNPTi5zdHJpbmdpZnkocmVjb3JkKSk7XG4gICAgICAgICAgICAgICAgICAgIGRlbGV0ZSByZWNvcmRTdGF0ZXNbcmVjb3JkLmlkXTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIGlzRXhpc3RpbmdTdGF0ZUZvcihyZWNvcmRJZCkge1xuICAgICAgICAgICAgcmV0dXJuICEhcmVjb3JkU3RhdGVzW3JlY29yZElkXTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIHVwZGF0ZVN5bmNlZE9iamVjdChyZWNvcmQpIHtcbiAgICAgICAgICAgIHJlY29yZFN0YXRlc1tyZWNvcmQuaWRdID0gcmVjb3JkO1xuICAgICAgICAgICAgY2xlYXJPYmplY3QoY2FjaGUpO1xuICAgICAgICAgICAgaWYgKCFyZWNvcmQucmVtb3ZlKSB7XG4gICAgICAgICAgICAgICAgYW5ndWxhci5leHRlbmQoY2FjaGUsIHJlY29yZCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiB1cGRhdGVTeW5jZWRBcnJheShyZWNvcmQpIHtcbiAgICAgICAgICAgIHZhciBleGlzdGluZyA9IHJlY29yZFN0YXRlc1tyZWNvcmQuaWRdO1xuICAgICAgICAgICAgaWYgKCFleGlzdGluZykge1xuICAgICAgICAgICAgICAgIC8vIGFkZCBuZXcgaW5zdGFuY2VcbiAgICAgICAgICAgICAgICByZWNvcmRTdGF0ZXNbcmVjb3JkLmlkXSA9IHJlY29yZDtcbiAgICAgICAgICAgICAgICBpZiAoIXJlY29yZC5yZW1vdmVkKSB7XG4gICAgICAgICAgICAgICAgICAgIGNhY2hlLnB1c2gocmVjb3JkKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIC8vIHVwZGF0ZSB0aGUgaW5zdGFuY2VcbiAgICAgICAgICAgICAgICBjbGVhck9iamVjdChleGlzdGluZyk7XG4gICAgICAgICAgICAgICAgYW5ndWxhci5leHRlbmQoZXhpc3RpbmcsIHJlY29yZCk7XG4gICAgICAgICAgICAgICAgaWYgKHJlY29yZC5yZW1vdmVkKSB7XG4gICAgICAgICAgICAgICAgICAgIGNhY2hlLnNwbGljZShjYWNoZS5pbmRleE9mKGV4aXN0aW5nKSwgMSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gY2xlYXJPYmplY3Qob2JqZWN0KSB7XG4gICAgICAgICAgICBPYmplY3Qua2V5cyhvYmplY3QpLmZvckVhY2goZnVuY3Rpb24gKGtleSkgeyBkZWxldGUgb2JqZWN0W2tleV07IH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gZ2V0UmV2aXNpb24ocmVjb3JkKSB7XG4gICAgICAgICAgICAvLyB3aGF0IHJlc2VydmVkIGZpZWxkIGRvIHdlIHVzZSBhcyB0aW1lc3RhbXBcbiAgICAgICAgICAgIGlmIChhbmd1bGFyLmlzRGVmaW5lZChyZWNvcmQucmV2aXNpb24pKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlY29yZC5yZXZpc2lvbjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChhbmd1bGFyLmlzRGVmaW5lZChyZWNvcmQudGltZXN0YW1wKSkge1xuICAgICAgICAgICAgICAgIHJldHVybiByZWNvcmQudGltZXN0YW1wO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdTeW5jIHJlcXVpcmVzIGEgcmV2aXNpb24gb3IgdGltZXN0YW1wIHByb3BlcnR5IGluIHJlY2VpdmVkICcgKyAob2JqZWN0Q2xhc3MgPyAnb2JqZWN0IFsnICsgb2JqZWN0Q2xhc3MubmFtZSArICddJyA6ICdyZWNvcmQnKSk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiB0aGlzIG9iamVjdCBcbiAgICAgKi9cbiAgICBmdW5jdGlvbiBTeW5jTGlzdGVuZXIoKSB7XG4gICAgICAgIHZhciBldmVudHMgPSB7fTtcbiAgICAgICAgdmFyIGNvdW50ID0gMDtcblxuICAgICAgICB0aGlzLm5vdGlmeSA9IG5vdGlmeTtcbiAgICAgICAgdGhpcy5vbiA9IG9uO1xuXG4gICAgICAgIGZ1bmN0aW9uIG5vdGlmeShldmVudCwgZGF0YTEsIGRhdGEyKSB7XG4gICAgICAgICAgICB2YXIgbGlzdGVuZXJzID0gZXZlbnRzW2V2ZW50XTtcbiAgICAgICAgICAgIGlmIChsaXN0ZW5lcnMpIHtcbiAgICAgICAgICAgICAgICBfLmZvckVhY2gobGlzdGVuZXJzLCBmdW5jdGlvbiAoY2FsbGJhY2ssIGlkKSB7XG4gICAgICAgICAgICAgICAgICAgIGNhbGxiYWNrKGRhdGExLCBkYXRhMik7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICAvKipcbiAgICAgICAgICogQHJldHVybnMgaGFuZGxlciB0byB1bnJlZ2lzdGVyIGxpc3RlbmVyXG4gICAgICAgICAqL1xuICAgICAgICBmdW5jdGlvbiBvbihldmVudCwgY2FsbGJhY2spIHtcbiAgICAgICAgICAgIHZhciBsaXN0ZW5lcnMgPSBldmVudHNbZXZlbnRdO1xuICAgICAgICAgICAgaWYgKCFsaXN0ZW5lcnMpIHtcbiAgICAgICAgICAgICAgICBsaXN0ZW5lcnMgPSBldmVudHNbZXZlbnRdID0ge307XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICB2YXIgaWQgPSBjb3VudCsrO1xuICAgICAgICAgICAgbGlzdGVuZXJzW2lkKytdID0gY2FsbGJhY2s7XG4gICAgICAgICAgICByZXR1cm4gZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgIGRlbGV0ZSBsaXN0ZW5lcnNbaWRdO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuICAgIGZ1bmN0aW9uIGdldENvbnNvbGUoKSB7XG4gICAgICAgIC8vIHRvIGhlbHAgd2l0aCBkZWJ1Z2dpbmcgZm9yIG5vdyB1bnRpbCB3ZSBvcHQgZm9yIGEgbmljZSBsb2dnZXIuIEluIHByb2R1Y3Rpb24sIGxvZyBhbmQgZGVidWcgc2hvdWxkIGF1dG9tYXRpY2FsbHkgYmUgcmVtb3ZlZCBieSB0aGUgYnVpbGQgZnJvbSB0aGUgY29kZS4uLi4gVE9ETzpuZWVkIHRvIGNoZWNrIG91dCB0aGUgcHJvZHVjdGlvbiBjb2RlXG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBsb2c6IGZ1bmN0aW9uIChtc2cpIHtcbiAgICAgICAgICAgICAgICB3aW5kb3cuY29uc29sZS5kZWJ1ZygnU1lOQyhpbmZvKTogJyArIG1zZyk7XG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgZGVidWc6IGZ1bmN0aW9uIChtc2cpIHtcbiAgICAgICAgICAgICAgICAvLyAgd2luZG93LmNvbnNvbGUuZGVidWcoJ1NZTkMoZGVidWcpOiAnICsgbXNnKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfTtcbiAgICB9XG59O1xuXG4iXSwic291cmNlUm9vdCI6Ii9zb3VyY2UvIn0=
