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


//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImFuZ3VsYXItc3luYy5qcyIsIi9zb3VyY2Uvc3luYy5tb2R1bGUuanMiLCIvc291cmNlL3NlcnZpY2VzL3N5bmMtZ2FyYmFnZS1jb2xsZWN0b3Iuc2VydmljZS5qcyIsIi9zb3VyY2Uvc2VydmljZXMvc3luYy5zZXJ2aWNlLmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLENBQUMsV0FBVztBQUNaOztBQ0RBO0tBQ0EsT0FBQSxRQUFBLENBQUE7S0FDQSw2QkFBQSxTQUFBLGtCQUFBO1FBQ0Esa0JBQUEsU0FBQTs7OztBRE9BLENBQUMsV0FBVztBQUNaOztBRVhBO0tBQ0EsT0FBQTtLQUNBLFFBQUEseUJBQUE7Ozs7Ozs7Ozs7QUFVQSxTQUFBLHVCQUFBO0lBQ0EsSUFBQSxRQUFBO0lBQ0EsSUFBQSxVQUFBO0lBQ0EsSUFBQSxZQUFBOztJQUVBLElBQUEsVUFBQTtRQUNBLFlBQUE7UUFDQSxZQUFBO1FBQ0EsU0FBQTtRQUNBLFVBQUE7UUFDQSxLQUFBO1FBQ0EsY0FBQTs7O0lBR0EsT0FBQTs7OztJQUlBLFNBQUEsV0FBQSxPQUFBO1FBQ0EsVUFBQTs7O0lBR0EsU0FBQSxhQUFBO1FBQ0EsT0FBQTs7O0lBR0EsU0FBQSxlQUFBO1FBQ0EsT0FBQSxNQUFBOzs7SUFHQSxTQUFBLFFBQUEsU0FBQTtRQUNBLE1BQUEsS0FBQTtZQUNBLFdBQUEsS0FBQTtZQUNBLFNBQUE7O1FBRUEsSUFBQSxDQUFBLFdBQUE7WUFDQSxRQUFBOzs7O0lBSUEsU0FBQSxXQUFBO1FBQ0EsSUFBQSxDQUFBLFNBQUE7WUFDQSxRQUFBO1lBQ0E7O1FBRUEsWUFBQTtRQUNBLFdBQUEsWUFBQTtZQUNBLFFBQUE7WUFDQSxJQUFBLE1BQUEsU0FBQSxHQUFBO2dCQUNBO21CQUNBO2dCQUNBLFlBQUE7O1dBRUEsVUFBQTs7O0lBR0EsU0FBQSxNQUFBO1FBQ0EsSUFBQSxVQUFBLEtBQUEsUUFBQSxVQUFBO1FBQ0EsT0FBQSxNQUFBLFNBQUEsS0FBQSxNQUFBLEdBQUEsYUFBQSxTQUFB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LENBQUEsTUFBQSxNQUFBOzt3QkFFQSxlQUFBO3dCQUNBLElBQUEsQ0FBQSxVQUFBOzRCQUNBLE1BQUEsU0FBQTs7O29CQUdBLGFBQUEsTUFBQTtvQkFDQSxJQUFBLENBQUEsd0JBQUE7d0JBQ0EseUJBQUE7d0JBQ0EsdUJBQUEsUUFBQTs7Ozs7Ozs7O1FBU0EsU0FBQSx3Q0FBQSxhQUFBOzs7O1lBSUEsSUFBQSxDQUFBLGFBQUEsT0FBQSxLQUFBLFdBQUEsVUFBQSxHQUFBO2dCQUNBLE9BQUE7O1lBRUEsSUFBQSxXQUFBO1lBQ0EsS0FBQSxJQUFBLFNBQUEsYUFBQTs7O2dCQUdBLElBQUEsWUFBQSxXQUFBLFVBQUEsUUFBQTtvQkFDQTs7O1lBR0EsT0FBQTs7Ozs7UUFLQSxTQUFBLGFBQUEsU0FBQTtZQUNBLElBQUEsZUFBQTtZQUNBLElBQUE7WUFDQSxJQUFBLFFBQUE7WUFDQSxRQUFBLFFBQUEsVUFBQSxRQUFBOztnQkFFQSxJQUFBLE9BQUEsUUFBQTtvQkFDQSxhQUFBO3VCQUNBLElBQUEsYUFBQSxPQUFBLEtBQUE7O29CQUVBLFVBQUEsYUFBQTt1QkFDQTtvQkFDQSxVQUFBLFVBQUE7O2dCQUVBLElBQUEsU0FBQTtvQkFDQSxhQUFBLEtBQUE7OztZQUdBLElBQUEsUUFBQTtZQUNBLElBQUEsVUFBQTtnQkFDQSxhQUFBLE9BQUEsU0FBQTttQkFDQTtnQkFDQSxhQUFBLE9BQUEsU0FBQSxXQUFBOzs7Ozs7Ozs7UUFTQSxTQUFBLFVBQUE7WUFDQSxPQUFBLEtBQUE7Ozs7OztRQU1BLFNBQUEsTUFBQSxVQUFBO1lBQ0EsT0FBQSxhQUFBLEdBQUEsT0FBQTs7Ozs7OztRQU9BLFNBQUEsU0FBQSxVQUFBO1lBQ0EsT0FBQSxhQUFBLEdBQUEsVUFBQTs7Ozs7OztRQU9BLFNBQUEsU0FBQSxVQUFBO1lBQ0EsT0FBQSxhQUFBLEdBQUEsVUFBQTs7Ozs7OztRQU9BLFNBQUEsUUFBQSxVQUFBO1lBQ0EsT0FBQSxhQUFBLEdBQUEsU0FBQTs7OztRQUlBLFNBQUEsVUFBQSxRQUFBO1lBQ0EsUUFBQSxNQUFBLGtDQUFBLE9BQUEsS0FBQSwwQkFBQTtZQUNBLFlBQUE7WUFDQSxrQkFBQSxlQUFBLGFBQUEsVUFBQTtZQUNBLGFBQUEsT0FBQSxPQUFBO1lBQ0EsT0FBQTs7O1FBR0EsU0FBQSxhQUFBLFFBQUE7WUFDQSxJQUFBLFdBQUEsYUFBQSxPQUFBO1lBQ0EsSUFBQSxZQUFBLFdBQUEsWUFBQSxXQUFBO2dCQUNBLE9BQUE7O1lBRUEsUUFBQSxNQUFBLDZCQUFBLE9BQUEsS0FBQSwwQkFBQTtZQUNBLGtCQUFBLGVBQUEsYUFBQSxVQUFBO1lBQ0EsYUFBQSxPQUFBLFVBQUE7WUFDQSxPQUFBOzs7O1FBSUEsU0FBQSxhQUFBLFFBQUE7WUFDQSxJQUFBLFdBQUEsYUFBQSxPQUFBO1lBQ0EsSUFBQSxDQUFBLFlBQUEsWUFBQSxVQUFBLFlBQUEsV0FBQTtnQkFDQSxRQUFBLE1BQUEsc0JBQUEsT0FBQSxLQUFBLDBCQUFBOzs7Z0JBR0EsT0FBQSxVQUFBO2dCQUNBLGtCQUFBOztnQkFFQSxJQUFBLFVBQUE7b0JBQ0EsYUFBQSxPQUFBLFVBQUE7b0JBQ0EsUUFBQTs7OztRQUlBLFNBQUEsUUFBQSxRQUFBO1lBQ0Esc0JBQUEsUUFBQSxTQUFBLFVBQUE7Z0JBQ0EsSUFBQSxpQkFBQSxhQUFBLE9BQUE7Z0JBQ0EsSUFBQSxrQkFBQSxPQUFBLFlBQUEsZUFBQTtrQkFDQTs7b0JBRUEsT0FBQSxhQUFBLE9BQUE7Ozs7O1FBS0EsU0FBQSxtQkFBQSxVQUFBO1lBQ0EsT0FBQSxDQUFBLENBQUEsYUFBQTs7O1FBR0EsU0FBQSxtQkFBQSxRQUFBO1lBQ0EsYUFBQSxPQUFBLE1BQUE7WUFDQSxZQUFBO1lBQ0EsSUFBQSxDQUFBLE9BQUEsUUFBQTtnQkFDQSxRQUFBLE9BQUEsT0FBQTs7OztRQUlBLFNBQUEsa0JBQUEsUUFBQTtZQUNBLElBQUEsV0FBQSxhQUFBLE9BQUE7WUFDQSxJQUFBLENBQUEsVUFBQTs7Z0JBRUEsYUFBQSxPQUFBLE1BQUE7Z0JBQ0EsSUFBQSxDQUFBLE9BQUEsU0FBQTtvQkFDQSxNQUFBLEtBQUE7O21CQUVBOztnQkFFQSxZQUFBO2dCQUNBLFFBQUEsT0FBQSxVQUFBO2dCQUNBLElBQUEsT0FBQSxTQUFBO29CQUNBLE1BQUEsT0FBQSxNQUFBLFFBQUEsV0FBQTs7Ozs7UUFLQSxTQUFBLFlBQUEsUUFBQTtZQUNBLE9BQUEsS0FBQSxRQUFBLFFBQUEsVUFBQSxLQUFBLEVBQUEsT0FBQSxPQUFBOzs7UUFHQSxTQUFBLFlBQUEsUUFBQTs7WUFFQSxJQUFBLFFBQUEsVUFBQSxPQUFBLFdBQUE7Z0JBQ0EsT0FBQSxPQUFBOztZQUVBLElBQUEsUUFBQSxVQUFBLE9BQUEsWUFBQTtnQkFDQSxPQUFBLE9BQUE7O1lBRUEsTUFBQSxJQUFBLE1BQUEsaUVBQUEsY0FBQSxhQUFBLFlBQUEsT0FBQSxNQUFBOzs7Ozs7O0lBT0EsU0FBQSxlQUFBO1FBQ0EsSUFBQSxTQUFBO1FBQ0EsSUFBQSxRQUFBOztRQUVBLEtBQUEsU0FBQTtRQUNBLEtBQUEsS0FBQTs7UUFFQSxTQUFBLE9BQUEsT0FBQSxPQUFBLE9BQUE7WUFDQSxJQUFBLFlBQUEsT0FBQTtZQUNBLElBQUEsV0FBQTtnQkFDQSxFQUFBLFFBQUEsV0FBQSxVQUFBLFVBQUEsSUFBQTtvQkFDQSxTQUFBLE9BQUE7Ozs7Ozs7O1FBUUEsU0FBQSxHQUFBLE9BQUEsVUFBQTtZQUNBLElBQUEsWUFBQSxPQUFBO1lBQ0EsSUFBQSxDQUFBLFdBQUE7Z0JBQ0EsWUFBQSxPQUFBLFNBQUE7O1lBRUEsSUFBQSxLQUFBO1lBQ0EsVUFBQSxRQUFBO1lBQ0EsT0FBQSxZQUFBO2dCQUNBLE9BQUEsVUFBQTs7OztJQUlBLFNBQUEsYUFBQTs7UUFFQSxPQUFBO1lBQ0EsS0FBQSxVQUFBLEtBQUE7Z0JBQ0EsT0FBQSxRQUFBLE1BQUEsaUJBQUE7O1lBRUEsT0FBQSxVQUFBLEtBQUE7Ozs7O0NBS0E7OztBSCtGQSIsImZpbGUiOiJhbmd1bGFyLXN5bmMuanMiLCJzb3VyY2VzQ29udGVudCI6WyIoZnVuY3Rpb24oKSB7XG5cInVzZSBzdHJpY3RcIjtcblxuYW5ndWxhclxuICAgIC5tb2R1bGUoJ3N5bmMnLCBbJ3NvY2tldGlvLWF1dGgnXSlcbiAgICAuY29uZmlnKGZ1bmN0aW9uKCRzb2NrZXRpb1Byb3ZpZGVyKXtcbiAgICAgICAgJHNvY2tldGlvUHJvdmlkZXIuc2V0RGVidWcodHJ1ZSk7XG4gICAgfSk7XG59KCkpO1xuXG4oZnVuY3Rpb24oKSB7XG5cInVzZSBzdHJpY3RcIjtcblxuYW5ndWxhclxuICAgIC5tb2R1bGUoJ3N5bmMnKVxuICAgIC5mYWN0b3J5KCckc3luY0dhcmJhZ2VDb2xsZWN0b3InLCBzeW5jR2FyYmFnZUNvbGxlY3Rvcik7XG5cbi8qKlxuICogc2FmZWx5IHJlbW92ZSBkZWxldGVkIHJlY29yZC9vYmplY3QgZnJvbSBtZW1vcnkgYWZ0ZXIgdGhlIHN5bmMgcHJvY2VzcyBkaXNwb3NlZCB0aGVtLlxuICogXG4gKiBUT0RPOiBTZWNvbmRzIHNob3VsZCByZWZsZWN0IHRoZSBtYXggdGltZSAgdGhhdCBzeW5jIGNhY2hlIGlzIHZhbGlkIChuZXR3b3JrIGxvc3Mgd291bGQgZm9yY2UgYSByZXN5bmMpLCB3aGljaCBzaG91bGQgbWF0Y2ggbWF4RGlzY29ubmVjdGlvblRpbWVCZWZvcmVEcm9wcGluZ1N1YnNjcmlwdGlvbiBvbiB0aGUgc2VydmVyIHNpZGUuXG4gKiBcbiAqIE5vdGU6XG4gKiByZW1vdmVkIHJlY29yZCBzaG91bGQgYmUgZGVsZXRlZCBmcm9tIHRoZSBzeW5jIGludGVybmFsIGNhY2hlIGFmdGVyIGEgd2hpbGUgc28gdGhhdCB0aGV5IGRvIG5vdCBzdGF5IGluIHRoZSBtZW1vcnkuIFRoZXkgY2Fubm90IGJlIHJlbW92ZWQgdG9vIGVhcmx5IGFzIGFuIG9sZGVyIHZlcnNpb24vc3RhbXAgb2YgdGhlIHJlY29yZCBjb3VsZCBiZSByZWNlaXZlZCBhZnRlciBpdHMgcmVtb3ZhbC4uLndoaWNoIHdvdWxkIHJlLWFkZCB0byBjYWNoZS4uLmR1ZSBhc3luY2hyb25vdXMgcHJvY2Vzc2luZy4uLlxuICovXG5mdW5jdGlvbiBzeW5jR2FyYmFnZUNvbGxlY3RvcigpIHtcbiAgICB2YXIgaXRlbXMgPSBbXTtcbiAgICB2YXIgc2Vjb25kcyA9IDI7XG4gICAgdmFyIHNjaGVkdWxlZCA9IGZhbHNlO1xuXG4gICAgdmFyIHNlcnZpY2UgPSB7XG4gICAgICAgIHNldFNlY29uZHM6IHNldFNlY29uZHMsXG4gICAgICAgIGdldFNlY29uZHM6IGdldFNlY29uZHMsXG4gICAgICAgIGRpc3Bvc2U6IGRpc3Bvc2UsXG4gICAgICAgIHNjaGVkdWxlOiBzY2hlZHVsZSxcbiAgICAgICAgcnVuOiBydW4sXG4gICAgICAgIGdldEl0ZW1Db3VudDogZ2V0SXRlbUNvdW50XG4gICAgfTtcblxuICAgIHJldHVybiBzZXJ2aWNlO1xuXG4gICAgLy8vLy8vLy8vL1xuXG4gICAgZnVuY3Rpb24gc2V0U2Vjb25kcyh2YWx1ZSkge1xuICAgICAgICBzZWNvbmRzID0gdmFsdWU7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gZ2V0U2Vjb25kcygpIHtcbiAgICAgICAgcmV0dXJuIHNlY29uZHM7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gZ2V0SXRlbUNvdW50KCkge1xuICAgICAgICByZXR1cm4gaXRlbXMubGVuZ3RoO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIGRpc3Bvc2UoY29sbGVjdCkge1xuICAgICAgICBpdGVtcy5wdXNoKHtcbiAgICAgICAgICAgIHRpbWVzdGFtcDogRGF0ZS5ub3coKSxcbiAgICAgICAgICAgIGNvbGxlY3Q6IGNvbGxlY3RcbiAgICAgICAgfSk7XG4gICAgICAgIGlmICghc2NoZWR1bGVkKSB7XG4gICAgICAgICAgICBzZXJ2aWNlLnNjaGVkdWxlKCk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBmdW5jdGlvbiBzY2hlZHVsZSgpIHtcbiAgICAgICAgaWYgKCFzZWNvbmRzKSB7XG4gICAgICAgICAgICBzZXJ2aWNlLnJ1bigpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIHNjaGVkdWxlZCA9IHRydWU7XG4gICAgICAgIHNldFRpbWVvdXQoZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgc2VydmljZS5ydW4oKTtcbiAgICAgICAgICAgIGlmIChpdGVtcy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICAgICAgc2NoZWR1bGUoKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgc2NoZWR1bGVkID0gZmFsc2U7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0sIHNlY29uZHMgKiAxMDAwKTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBydW4oKSB7XG4gICAgICAgIHZhciB0aW1lb3V0ID0gRGF0ZS5ub3coKSAtIHNlY29uZHMgKiAxMDAwO1xuICAgICAgICB3aGlsZSAoaXRlbXMubGVuZ3RoID4gMCAmJiBpdGVtc1swXS50aW1lc3RhbXAgPD0gdGltZW91dCkge1xuICAgICAgICAgICAgaXRlbXMuc2hpZnQoKS5jb2xsZWN0KCk7XG4gICAgICAgIH1cbiAgICB9XG59XG59KCkpO1xuXG4oZnVuY3Rpb24oKSB7XG5cInVzZSBzdHJpY3RcIjtcblxuLyoqXG4gKiBcbiAqIFNlcnZpY2UgdGhhdCBhbGxvd3MgYW4gYXJyYXkgb2YgZGF0YSByZW1haW4gaW4gc3luYyB3aXRoIGJhY2tlbmQuXG4gKiBcbiAqIElmIG5ldHdvcmsgaXMgbG9zdCwgd2UgbG9hZCB3aGF0IHdlIG1pc3NlZCB0aGFua3MgdG8gdGhlIHRpbWVzdGFtcC4uXG4gKiBcbiAqIGV4OlxuICogd2hlbiB0aGVyZSBpcyBhIG5vdGlmaWNhdGlvbiwgbm90aWNhdGlvblNlcnZpY2Ugbm90aWZpZXMgdGhhdCB0aGVyZSBpcyBzb21ldGhpbmcgbmV3Li4udGhlbiB0aGUgZGF0YXNldCBnZXQgdGhlIGRhdGEgYW5kIG5vdGlmaWVzIGFsbCBpdHMgY2FsbGJhY2suXG4gKiBcbiAqIE5PVEU6IFxuICogIFxuICogXG4gKiBQcmUtUmVxdWlzdGU6XG4gKiAtLS0tLS0tLS0tLS0tXG4gKiBTeW5jIGRvZXMgbm90IHdvcmsgaWYgb2JqZWN0cyBkbyBub3QgaGF2ZSBCT1RIIGlkIGFuZCByZXZpc2lvbiBmaWVsZCEhISFcbiAqIFxuICogV2hlbiB0aGUgYmFja2VuZCB3cml0ZXMgYW55IGRhdGEgdG8gdGhlIGRiIHRoYXQgYXJlIHN1cHBvc2VkIHRvIGJlIHN5bmNyb25pemVkOlxuICogSXQgbXVzdCBtYWtlIHN1cmUgZWFjaCBhZGQsIHVwZGF0ZSwgcmVtb3ZhbCBvZiByZWNvcmQgaXMgdGltZXN0YW1wZWQuXG4gKiBJdCBtdXN0IG5vdGlmeSB0aGUgZGF0YXN0cmVhbSAod2l0aCBub3RpZnlDaGFuZ2Ugb3Igbm90aWZ5UmVtb3ZhbCkgd2l0aCBzb21lIHBhcmFtcyBzbyB0aGF0IGJhY2tlbmQga25vd3MgdGhhdCBpdCBoYXMgdG8gcHVzaCBiYWNrIHRoZSBkYXRhIGJhY2sgdG8gdGhlIHN1YnNjcmliZXJzIChleDogdGhlIHRhc2tDcmVhdGlvbiB3b3VsZCBub3RpZnkgd2l0aCBpdHMgcGxhbklkKVxuKiBcbiAqIFxuICovXG5hbmd1bGFyXG4gICAgLm1vZHVsZSgnc3luYycpXG4gICAgLmZhY3RvcnkoJyRzeW5jJywgc3luYyk7XG5cbmZ1bmN0aW9uIHN5bmMoJHJvb3RTY29wZSwgJHEsICRzb2NrZXRpbywgJHN5bmNHYXJiYWdlQ29sbGVjdG9yKSB7XG4gICAgdmFyIHB1YmxpY2F0aW9uTGlzdGVuZXJzID0ge30sXG4gICAgICAgIHB1YmxpY2F0aW9uTGlzdGVuZXJDb3VudCA9IDA7XG4gICAgdmFyIEdSQUNFX1BFUklPRF9JTl9TRUNPTkRTID0gODtcbiAgICB2YXIgU1lOQ19WRVJTSU9OID0gJzEuMCc7XG4gICAgdmFyIGNvbnNvbGUgPSBnZXRDb25zb2xlKCk7XG5cbiAgICBsaXN0ZW5Ub1N5bmNOb3RpZmljYXRpb24oKTtcblxuICAgIHZhciBzZXJ2aWNlID0ge1xuICAgICAgICBzdWJzY3JpYmU6IHN1YnNjcmliZSxcbiAgICAgICAgcmVzb2x2ZVN1YnNjcmlwdGlvbjogcmVzb2x2ZVN1YnNjcmlwdGlvbixcbiAgICAgICAgZ2V0R3JhY2VQZXJpb2Q6IGdldEdyYWNlUGVyaW9kXG4gICAgfTtcblxuICAgIHJldHVybiBzZXJ2aWNlO1xuXG4gICAgLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy9cbiAgICAvKipcbiAgICAgKiBzdWJzY3JpYmUgdG8gcHVibGljYXRpb24gYW5kIHJldHVybnMgdGhlIHN1YnNjcmlwdGlvbiB3aGVuIGRhdGEgaXMgYXZhaWxhYmxlLiBcbiAgICAgKiBAcGFyYW0gcHVibGljYXRpb24gbmFtZS4gb24gdGhlIHNlcnZlciBzaWRlLCBhIHB1YmxpY2F0aW9uIHNoYWxsIGV4aXN0LiBleDogbWFnYXppbmVzLnN5bmNcbiAgICAgKiBAcGFyYW0gcGFyYW1zICAgdGhlIHBhcmFtcyBvYmplY3QgcGFzc2VkIHRvIHRoZSBzdWJzY3JpcHRpb24sIGV4OiB7bWFnYXppbmVJZDonZW50cmVwcmVuZXVyJ30pXG4gICAgICogQHBhcmFtIG9iamVjdENsYXNzIGFuIGluc3RhbmNlIG9mIHRoaXMgY2xhc3Mgd2lsbCBiZSBjcmVhdGVkIGZvciBlYWNoIHJlY29yZCByZWNlaXZlZC5cbiAgICAgKiByZXR1cm5zIGEgcHJvbWlzZSByZXR1cm5pbmcgdGhlIHN1YnNjcmlwdGlvbiB3aGVuIHRoZSBkYXRhIGlzIHN5bmNlZFxuICAgICAqIG9yIHJlamVjdHMgaWYgdGhlIGluaXRpYWwgc3luYyBmYWlscyB0byBjb21wbGV0ZSBpbiBhIGxpbWl0ZWQgYW1vdW50IG9mIHRpbWUuIFxuICAgICAqIFxuICAgICAqIHRvIGdldCB0aGUgZGF0YSBmcm9tIHRoZSBkYXRhU2V0LCBqdXN0IGRhdGFTZXQuZ2V0RGF0YSgpXG4gICAgICovXG4gICAgZnVuY3Rpb24gcmVzb2x2ZVN1YnNjcmlwdGlvbihwdWJsaWNhdGlvbk5hbWUsIHBhcmFtcywgb2JqZWN0Q2xhc3MpIHtcbiAgICAgICAgdmFyIGRlZmVycmVkID0gJHEuZGVmZXIoKTtcbiAgICAgICAgdmFyIHNEcyA9IHN1YnNjcmliZShwdWJsaWNhdGlvbk5hbWUpLnNldE9iamVjdENsYXNzKG9iamVjdENsYXNzKTtcblxuICAgICAgICAvLyBnaXZlIGEgbGl0dGxlIHRpbWUgZm9yIHN1YnNjcmlwdGlvbiB0byBmZXRjaCB0aGUgZGF0YS4uLm90aGVyd2lzZSBnaXZlIHVwIHNvIHRoYXQgd2UgZG9uJ3QgZ2V0IHN0dWNrIGluIGEgcmVzb2x2ZSB3YWl0aW5nIGZvcmV2ZXIuXG4gICAgICAgIHZhciBncmFjZVBlcmlvZCA9IHNldFRpbWVvdXQoZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgaWYgKCFzRHMucmVhZHkpIHtcbiAgICAgICAgICAgICAgICBzRHMuZGVzdHJveSgpO1xuICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKCdBdHRlbXB0IHRvIHN1YnNjcmliZSB0byBwdWJsaWNhdGlvbiAnICsgcHVibGljYXRpb25OYW1lICsgJyBmYWlsZWQnKTtcbiAgICAgICAgICAgICAgICBkZWZlcnJlZC5yZWplY3QoJ1NZTkNfVElNRU9VVCcpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9LCBHUkFDRV9QRVJJT0RfSU5fU0VDT05EUyAqIDEwMDApO1xuXG4gICAgICAgIHNEcy5zZXRQYXJhbWV0ZXJzKHBhcmFtcylcbiAgICAgICAgICAgIC53YWl0Rm9yRGF0YVJlYWR5KClcbiAgICAgICAgICAgIC50aGVuKGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICBjbGVhclRpbWVvdXQoZ3JhY2VQZXJpb2QpO1xuICAgICAgICAgICAgICAgIGRlZmVycmVkLnJlc29sdmUoc0RzKTtcbiAgICAgICAgICAgIH0pLmNhdGNoKGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICBjbGVhclRpbWVvdXQoZ3JhY2VQZXJpb2QpO1xuICAgICAgICAgICAgICAgIHNEcy5kZXN0cm95KCk7XG4gICAgICAgICAgICAgICAgZGVmZXJyZWQucmVqZWN0KCdGYWlsZWQgdG8gc3Vic2NyaWJlIHRvIHB1YmxpY2F0aW9uICcgKyBwdWJsaWNhdGlvbk5hbWUgKyAnIGZhaWxlZCcpO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIHJldHVybiBkZWZlcnJlZC5wcm9taXNlO1xuICAgIH1cblxuICAgIC8qKlxuICAgICAqIFxuICAgICAqIGZvciB0ZXN0IHB1cnBvc2VzLCByZXR1cm5zIHRoZSB0aW1lIHJlc29sdmVTdWJzY3JpcHRpb24gYmVmb3JlIGl0IHRpbWVzIG91dC5cbiAgICAgKi9cbiAgICBmdW5jdGlvbiBnZXRHcmFjZVBlcmlvZCgpIHtcbiAgICAgICAgcmV0dXJuIEdSQUNFX1BFUklPRF9JTl9TRUNPTkRTO1xuICAgIH1cbiAgICAvKipcbiAgICAgKiBzdWJzY3JpYmUgdG8gcHVibGljYXRpb24uIEl0IHdpbGwgbm90IHN5bmMgdW50aWwgeW91IHNldCB0aGUgcGFyYW1zLlxuICAgICAqIFxuICAgICAqIEBwYXJhbSBwdWJsaWNhdGlvbiBuYW1lLiBvbiB0aGUgc2VydmVyIHNpZGUsIGEgcHVibGljYXRpb24gc2hhbGwgZXhpc3QuIGV4OiBtYWdhemluZXMuc3luY1xuICAgICAqIEBwYXJhbSBwYXJhbXMgICB0aGUgcGFyYW1zIG9iamVjdCBwYXNzZWQgdG8gdGhlIHN1YnNjcmlwdGlvbiwgZXg6IHttYWdhemluZUlkOidlbnRyZXByZW5ldXInfSlcbiAgICAgKiByZXR1cm5zIHN1YnNjcmlwdGlvblxuICAgICAqIFxuICAgICAqL1xuICAgIGZ1bmN0aW9uIHN1YnNjcmliZShwdWJsaWNhdGlvbk5hbWUsIHNjb3BlKSB7XG4gICAgICAgIHJldHVybiBuZXcgU3Vic2NyaXB0aW9uKHB1YmxpY2F0aW9uTmFtZSwgc2NvcGUpO1xuICAgIH1cblxuXG5cbiAgICAvLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vL1xuICAgIC8vIEhFTFBFUlNcblxuICAgIC8vIGV2ZXJ5IHN5bmMgbm90aWZpY2F0aW9uIGNvbWVzIHRocnUgdGhlIHNhbWUgZXZlbnQgdGhlbiBpdCBpcyBkaXNwYXRjaGVzIHRvIHRoZSB0YXJnZXRlZCBzdWJzY3JpcHRpb25zLlxuICAgIGZ1bmN0aW9uIGxpc3RlblRvU3luY05vdGlmaWNhdGlvbigpIHtcbiAgICAgICAgJHNvY2tldGlvLm9uKCdTWU5DX05PVycsIGZ1bmN0aW9uIChzdWJOb3RpZmljYXRpb24sIGZuKSB7XG4gICAgICAgICAgICBjb25zb2xlLmxvZygnU3luY2luZyB3aXRoIHN1YnNjcmlwdGlvbiBbbmFtZTonICsgc3ViTm90aWZpY2F0aW9uLm5hbWUgKyAnLCBpZDonICsgc3ViTm90aWZpY2F0aW9uLnN1YnNjcmlwdGlvbklkICsgJyAsIHBhcmFtczonICsgSlNPTi5zdHJpbmdpZnkoc3ViTm90aWZpY2F0aW9uLnBhcmFtcykgKyAnXS4gUmVjb3JkczonICsgc3ViTm90aWZpY2F0aW9uLnJlY29yZHMubGVuZ3RoICsgJ1snICsgKHN1Yk5vdGlmaWNhdGlvbi5kaWZmID8gJ0RpZmYnIDogJ0FsbCcpICsgJ10nKTtcbiAgICAgICAgICAgIHZhciBsaXN0ZW5lcnMgPSBwdWJsaWNhdGlvbkxpc3RlbmVyc1tzdWJOb3RpZmljYXRpb24ubmFtZV07XG4gICAgICAgICAgICBpZiAobGlzdGVuZXJzKSB7XG4gICAgICAgICAgICAgICAgZm9yICh2YXIgbGlzdGVuZXIgaW4gbGlzdGVuZXJzKSB7XG4gICAgICAgICAgICAgICAgICAgIGxpc3RlbmVyc1tsaXN0ZW5lcl0oc3ViTm90aWZpY2F0aW9uKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBmbignU1lOQ0VEJyk7IC8vIGxldCBrbm93IHRoZSBiYWNrZW5kIHRoZSBjbGllbnQgd2FzIGFibGUgdG8gc3luYy5cbiAgICAgICAgfSk7XG4gICAgfTtcblxuXG4gICAgLy8gdGhpcyBhbGxvd3MgYSBkYXRhc2V0IHRvIGxpc3RlbiB0byBhbnkgU1lOQ19OT1cgZXZlbnQuLmFuZCBpZiB0aGUgbm90aWZpY2F0aW9uIGlzIGFib3V0IGl0cyBkYXRhLlxuICAgIGZ1bmN0aW9uIGFkZFB1YmxpY2F0aW9uTGlzdGVuZXIoc3RyZWFtTmFtZSwgY2FsbGJhY2spIHtcbiAgICAgICAgdmFyIHVpZCA9IHB1YmxpY2F0aW9uTGlzdGVuZXJDb3VudCsrO1xuICAgICAgICB2YXIgbGlzdGVuZXJzID0gcHVibGljYXRpb25MaXN0ZW5lcnNbc3RyZWFtTmFtZV07XG4gICAgICAgIGlmICghbGlzdGVuZXJzKSB7XG4gICAgICAgICAgICBwdWJsaWNhdGlvbkxpc3RlbmVyc1tzdHJlYW1OYW1lXSA9IGxpc3RlbmVycyA9IHt9O1xuICAgICAgICB9XG4gICAgICAgIGxpc3RlbmVyc1t1aWRdID0gY2FsbGJhY2s7XG5cbiAgICAgICAgcmV0dXJuIGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIGRlbGV0ZSBsaXN0ZW5lcnNbdWlkXTtcbiAgICAgICAgfVxuICAgIH1cbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAvLyBTdWJzY3JpcHRpb24gb2JqZWN0XG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gICAgLyoqXG4gICAgICogYSBzdWJzY3JpcHRpb24gc3luY2hyb25pemVzIHdpdGggdGhlIGJhY2tlbmQgZm9yIGFueSBiYWNrZW5kIGRhdGEgY2hhbmdlIGFuZCBtYWtlcyB0aGF0IGRhdGEgYXZhaWxhYmxlIHRvIGEgY29udHJvbGxlci5cbiAgICAgKiBcbiAgICAgKiAgV2hlbiBjbGllbnQgc3Vic2NyaWJlcyB0byBhbiBzeW5jcm9uaXplZCBhcGksIGFueSBkYXRhIGNoYW5nZSB0aGF0IGltcGFjdHMgdGhlIGFwaSByZXN1bHQgV0lMTCBiZSBQVVNIZWQgdG8gdGhlIGNsaWVudC5cbiAgICAgKiBJZiB0aGUgY2xpZW50IGRvZXMgTk9UIHN1YnNjcmliZSBvciBzdG9wIHN1YnNjcmliZSwgaXQgd2lsbCBubyBsb25nZXIgcmVjZWl2ZSB0aGUgUFVTSC4gXG4gICAgICogICAgXG4gICAgICogaWYgdGhlIGNvbm5lY3Rpb24gaXMgbG9zdCBmb3IgYSBzaG9ydCB0aW1lIChkdXJhdGlvbiBkZWZpbmVkIG9uIHNlcnZlci1zaWRlKSwgdGhlIHNlcnZlciBxdWV1ZXMgdGhlIGNoYW5nZXMgaWYgYW55LiBcbiAgICAgKiBXaGVuIHRoZSBjb25uZWN0aW9uIHJldHVybnMsIHRoZSBtaXNzaW5nIGRhdGEgYXV0b21hdGljYWxseSAgd2lsbCBiZSBQVVNIZWQgdG8gdGhlIHN1YnNjcmliaW5nIGNsaWVudC5cbiAgICAgKiBpZiB0aGUgY29ubmVjdGlvbiBpcyBsb3N0IGZvciBhIGxvbmcgdGltZSAoZHVyYXRpb24gZGVmaW5lZCBvbiB0aGUgc2VydmVyKSwgdGhlIHNlcnZlciB3aWxsIGRlc3Ryb3kgdGhlIHN1YnNjcmlwdGlvbi4gVG8gc2ltcGxpZnksIHRoZSBjbGllbnQgd2lsbCByZXN1YnNjcmliZSBhdCBpdHMgcmVjb25uZWN0aW9uIGFuZCBnZXQgYWxsIGRhdGEuXG4gICAgICogXG4gICAgICogc3Vic2NyaXB0aW9uIG9iamVjdCBwcm92aWRlcyAzIGNhbGxiYWNrcyAoYWRkLHVwZGF0ZSwgZGVsKSB3aGljaCBhcmUgY2FsbGVkIGR1cmluZyBzeW5jaHJvbml6YXRpb24uXG4gICAgICogICAgICBcbiAgICAgKiBTY29wZSB3aWxsIGFsbG93IHRoZSBzdWJzY3JpcHRpb24gc3RvcCBzeW5jaHJvbml6aW5nIGFuZCBjYW5jZWwgcmVnaXN0cmF0aW9uIHdoZW4gaXQgaXMgZGVzdHJveWVkLiBcbiAgICAgKiAgXG4gICAgICogQ29uc3RydWN0b3I6XG4gICAgICogXG4gICAgICogQHBhcmFtIHB1YmxpY2F0aW9uLCB0aGUgcHVibGljYXRpb24gbXVzdCBleGlzdCBvbiB0aGUgc2VydmVyIHNpZGVcbiAgICAgKiBAcGFyYW0gc2NvcGUsIGJ5IGRlZmF1bHQgJHJvb3RTY29wZSwgYnV0IGNhbiBiZSBtb2RpZmllZCBsYXRlciBvbiB3aXRoIGF0dGFjaCBtZXRob2QuXG4gICAgICovXG5cbiAgICBmdW5jdGlvbiBTdWJzY3JpcHRpb24ocHVibGljYXRpb24sIHNjb3BlKSB7XG4gICAgICAgIHZhciBzdWJzY3JpcHRpb25JZCwgbWF4UmV2aXNpb24gPSAwLCB0aW1lc3RhbXBGaWVsZCwgaXNTeW5jaW5nT24gPSBmYWxzZSwgaXNTaW5nbGUsIHVwZGF0ZURhdGFTdG9yYWdlLCBjYWNoZSwgaXNJbml0aWFsUHVzaENvbXBsZXRlZCwgZGVmZXJyZWRJbml0aWFsaXphdGlvbjtcbiAgICAgICAgdmFyIG9uUmVhZHlPZmYsIGZvcm1hdFJlY29yZDtcbiAgICAgICAgdmFyIHJlY29ubmVjdE9mZiwgcHVibGljYXRpb25MaXN0ZW5lck9mZiwgZGVzdHJveU9mZjtcbiAgICAgICAgdmFyIG9iamVjdENsYXNzO1xuXG4gICAgICAgIHZhciBzRHMgPSB0aGlzO1xuICAgICAgICB2YXIgc3ViUGFyYW1zID0ge307XG4gICAgICAgIHZhciByZWNvcmRTdGF0ZXMgPSB7fTtcbiAgICAgICAgdmFyIGlubmVyU2NvcGU7Ly89ICRyb290U2NvcGUuJG5ldyh0cnVlKTtcbiAgICAgICAgdmFyIHN5bmNMaXN0ZW5lciA9IG5ldyBTeW5jTGlzdGVuZXIoKTtcblxuICAgICAgICB0aGlzLnJlYWR5ID0gZmFsc2U7XG4gICAgICAgIHRoaXMuc3luY09uID0gc3luY09uO1xuICAgICAgICB0aGlzLnN5bmNPZmYgPSBzeW5jT2ZmO1xuICAgICAgICB0aGlzLnNldE9uUmVhZHkgPSBzZXRPblJlYWR5O1xuXG4gICAgICAgIHRoaXMub25SZWFkeSA9IG9uUmVhZHk7XG4gICAgICAgIHRoaXMub25VcGRhdGUgPSBvblVwZGF0ZTtcbiAgICAgICAgdGhpcy5vbkFkZCA9IG9uQWRkO1xuICAgICAgICB0aGlzLm9uUmVtb3ZlID0gb25SZW1vdmU7XG5cbiAgICAgICAgdGhpcy5nZXREYXRhID0gZ2V0RGF0YTtcbiAgICAgICAgdGhpcy5zZXRQYXJhbWV0ZXJzID0gc2V0UGFyYW1ldGVycztcblxuICAgICAgICB0aGlzLndhaXRGb3JEYXRhUmVhZHkgPSB3YWl0Rm9yRGF0YVJlYWR5O1xuICAgICAgICB0aGlzLndhaXRGb3JTdWJzY3JpcHRpb25SZWFkeSA9IHdhaXRGb3JTdWJzY3JpcHRpb25SZWFkeTtcblxuICAgICAgICB0aGlzLnNldEZvcmNlID0gc2V0Rm9yY2U7XG4gICAgICAgIHRoaXMuaXNTeW5jaW5nID0gaXNTeW5jaW5nO1xuICAgICAgICB0aGlzLmlzUmVhZHkgPSBpc1JlYWR5O1xuXG4gICAgICAgIHRoaXMuc2V0U2luZ2xlID0gc2V0U2luZ2xlO1xuXG4gICAgICAgIHRoaXMuc2V0T2JqZWN0Q2xhc3MgPSBzZXRPYmplY3RDbGFzcztcbiAgICAgICAgdGhpcy5nZXRPYmplY3RDbGFzcyA9IGdldE9iamVjdENsYXNzO1xuXG4gICAgICAgIHRoaXMuYXR0YWNoID0gYXR0YWNoO1xuICAgICAgICB0aGlzLmRlc3Ryb3kgPSBkZXN0cm95O1xuXG4gICAgICAgIHRoaXMuaXNFeGlzdGluZ1N0YXRlRm9yID0gaXNFeGlzdGluZ1N0YXRlRm9yOyAvLyBmb3IgdGVzdGluZyBwdXJwb3Nlc1xuXG4gICAgICAgIHNldFNpbmdsZShmYWxzZSk7XG5cbiAgICAgICAgLy8gdGhpcyB3aWxsIG1ha2Ugc3VyZSB0aGF0IHRoZSBzdWJzY3JpcHRpb24gaXMgcmVsZWFzZWQgZnJvbSBzZXJ2ZXJzIGlmIHRoZSBhcHAgY2xvc2VzIChjbG9zZSBicm93c2VyLCByZWZyZXNoLi4uKVxuICAgICAgICBhdHRhY2goc2NvcGUgfHwgJHJvb3RTY29wZSk7XG5cbiAgICAgICAgLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vL1xuXG4gICAgICAgIGZ1bmN0aW9uIGRlc3Ryb3koKSB7XG4gICAgICAgICAgICBzeW5jT2ZmKCk7XG4gICAgICAgIH1cblxuICAgICAgICAvKiogdGhpcyB3aWxsIGJlIGNhbGxlZCB3aGVuIGRhdGEgaXMgYXZhaWxhYmxlIFxuICAgICAgICAgKiAgaXQgbWVhbnMgcmlnaHQgYWZ0ZXIgZWFjaCBzeW5jIVxuICAgICAgICAgKiBcbiAgICAgICAgICogXG4gICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIHNldE9uUmVhZHkoY2FsbGJhY2spIHtcbiAgICAgICAgICAgIGlmIChvblJlYWR5T2ZmKSB7XG4gICAgICAgICAgICAgICAgb25SZWFkeU9mZigpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgb25SZWFkeU9mZiA9IG9uUmVhZHkoY2FsbGJhY2spO1xuICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgfVxuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiBmb3JjZSByZXN5bmNpbmcgZnJvbSBzY3JhdGNoIGV2ZW4gaWYgdGhlIHBhcmFtZXRlcnMgaGF2ZSBub3QgY2hhbmdlZFxuICAgICAgICAgKiBcbiAgICAgICAgICogaWYgb3V0c2lkZSBjb2RlIGhhcyBtb2RpZmllZCB0aGUgZGF0YSBhbmQgeW91IG5lZWQgdG8gcm9sbGJhY2ssIHlvdSBjb3VsZCBjb25zaWRlciBmb3JjaW5nIGEgcmVmcmVzaCB3aXRoIHRoaXMuIEJldHRlciBzb2x1dGlvbiBzaG91bGQgYmUgZm91bmQgdGhhbiB0aGF0LlxuICAgICAgICAgKiBcbiAgICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIHNldEZvcmNlKHZhbHVlKSB7XG4gICAgICAgICAgICBpZiAodmFsdWUpIHtcbiAgICAgICAgICAgICAgICAvLyBxdWljayBoYWNrIHRvIGZvcmNlIHRvIHJlbG9hZC4uLnJlY29kZSBsYXRlci5cbiAgICAgICAgICAgICAgICBzRHMuc3luY09mZigpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgfVxuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiBUaGUgZm9sbG93aW5nIG9iamVjdCB3aWxsIGJlIGJ1aWx0IHVwb24gZWFjaCByZWNvcmQgcmVjZWl2ZWQgZnJvbSB0aGUgYmFja2VuZFxuICAgICAgICAgKiBcbiAgICAgICAgICogVGhpcyBjYW5ub3QgYmUgbW9kaWZpZWQgYWZ0ZXIgdGhlIHN5bmMgaGFzIHN0YXJ0ZWQuXG4gICAgICAgICAqIFxuICAgICAgICAgKiBAcGFyYW0gY2xhc3NWYWx1ZVxuICAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gc2V0T2JqZWN0Q2xhc3MoY2xhc3NWYWx1ZSkge1xuICAgICAgICAgICAgaWYgKGRlZmVycmVkSW5pdGlhbGl6YXRpb24pIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBvYmplY3RDbGFzcyA9IGNsYXNzVmFsdWU7XG4gICAgICAgICAgICBmb3JtYXRSZWNvcmQgPSBmdW5jdGlvbiAocmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIG5ldyBvYmplY3RDbGFzcyhyZWNvcmQpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgc2V0U2luZ2xlKGlzU2luZ2xlKTtcbiAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiBnZXRPYmplY3RDbGFzcygpIHtcbiAgICAgICAgICAgIHJldHVybiBvYmplY3RDbGFzcztcbiAgICAgICAgfVxuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiB0aGlzIGZ1bmN0aW9uIHN0YXJ0cyB0aGUgc3luY2luZy5cbiAgICAgICAgICogT25seSBwdWJsaWNhdGlvbiBwdXNoaW5nIGRhdGEgbWF0Y2hpbmcgb3VyIGZldGNoaW5nIHBhcmFtcyB3aWxsIGJlIHJlY2VpdmVkLlxuICAgICAgICAgKiBcbiAgICAgICAgICogZXg6IGZvciBhIHB1YmxpY2F0aW9uIG5hbWVkIFwibWFnYXppbmVzLnN5bmNcIiwgaWYgZmV0Y2hpbmcgcGFyYW1zIGVxdWFsbGVkIHttYWdhemluTmFtZTonY2Fycyd9LCB0aGUgbWFnYXppbmUgY2FycyBkYXRhIHdvdWxkIGJlIHJlY2VpdmVkIGJ5IHRoaXMgc3Vic2NyaXB0aW9uLlxuICAgICAgICAgKiBcbiAgICAgICAgICogQHBhcmFtIGZldGNoaW5nUGFyYW1zXG4gICAgICAgICAqIEBwYXJhbSBvcHRpb25zXG4gICAgICAgICAqIFxuICAgICAgICAgKiBAcmV0dXJucyBhIHByb21pc2UgdGhhdCByZXNvbHZlcyB3aGVuIGRhdGEgaXMgYXJyaXZlZC5cbiAgICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIHNldFBhcmFtZXRlcnMoZmV0Y2hpbmdQYXJhbXMsIG9wdGlvbnMpIHtcbiAgICAgICAgICAgIGlmIChpc1N5bmNpbmdPbiAmJiBhbmd1bGFyLmVxdWFscyhmZXRjaGluZ1BhcmFtcywgc3ViUGFyYW1zKSkge1xuICAgICAgICAgICAgICAgIC8vIGlmIHRoZSBwYXJhbXMgaGF2ZSBub3QgY2hhbmdlZCwganVzdCByZXR1cm5zIHdpdGggY3VycmVudCBkYXRhLlxuICAgICAgICAgICAgICAgIHJldHVybiBzRHM7IC8vJHEucmVzb2x2ZShnZXREYXRhKCkpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgc3luY09mZigpO1xuICAgICAgICAgICAgaWYgKCFpc1NpbmdsZSkge1xuICAgICAgICAgICAgICAgIGNhY2hlLmxlbmd0aCA9IDA7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBtYXhSZXZpc2lvbiA9IDA7XG4gICAgICAgICAgICBzdWJQYXJhbXMgPSBmZXRjaGluZ1BhcmFtcyB8fCB7fTtcbiAgICAgICAgICAgIG9wdGlvbnMgPSBvcHRpb25zIHx8IHt9O1xuICAgICAgICAgICAgaWYgKGFuZ3VsYXIuaXNEZWZpbmVkKG9wdGlvbnMuc2luZ2xlKSkge1xuICAgICAgICAgICAgICAgIHNldFNpbmdsZShvcHRpb25zLnNpbmdsZSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBzeW5jT24oKTtcbiAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgIH1cblxuICAgICAgICAvLyB3YWl0IGZvciB0aGUgaW5pdGlhbCBmZXRjaCB0byBjb21wbGV0ZSB0aGVuIHJldHVybnMgdGhpcyBzdWJzY3JpcHRpb25cbiAgICAgICAgZnVuY3Rpb24gd2FpdEZvclN1YnNjcmlwdGlvblJlYWR5KCkge1xuICAgICAgICAgICAgcmV0dXJuIGRlZmVycmVkSW5pdGlhbGl6YXRpb24ucHJvbWlzZS50aGVuKGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICAvLyB3YWl0IGZvciB0aGUgaW5pdGlhbCBmZXRjaCB0byBjb21wbGV0ZSB0aGVuIHJldHVybnMgdGhlIGRhdGFcbiAgICAgICAgZnVuY3Rpb24gd2FpdEZvckRhdGFSZWFkeSgpIHtcbiAgICAgICAgICAgIHJldHVybiBkZWZlcnJlZEluaXRpYWxpemF0aW9uLnByb21pc2U7XG4gICAgICAgIH1cblxuICAgICAgICAvLyBkb2VzIHRoZSBkYXRhc2V0IHJldHVybnMgb25seSBvbmUgb2JqZWN0PyBub3QgYW4gYXJyYXk/XG4gICAgICAgIGZ1bmN0aW9uIHNldFNpbmdsZSh2YWx1ZSkge1xuICAgICAgICAgICAgaWYgKGRlZmVycmVkSW5pdGlhbGl6YXRpb24pIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBpc1NpbmdsZSA9IHZhbHVlO1xuICAgICAgICAgICAgaWYgKHZhbHVlKSB7XG4gICAgICAgICAgICAgICAgdXBkYXRlRGF0YVN0b3JhZ2UgPSB1cGRhdGVTeW5jZWRPYmplY3Q7XG4gICAgICAgICAgICAgICAgY2FjaGUgPSBvYmplY3RDbGFzcyA/IG5ldyBvYmplY3RDbGFzcyh7fSkgOiB7fTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgdXBkYXRlRGF0YVN0b3JhZ2UgPSB1cGRhdGVTeW5jZWRBcnJheTtcbiAgICAgICAgICAgICAgICBjYWNoZSA9IFtdO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIHJldHVybnMgdGhlIG9iamVjdCBvciBhcnJheSBpbiBzeW5jXG4gICAgICAgIGZ1bmN0aW9uIGdldERhdGEoKSB7XG4gICAgICAgICAgICByZXR1cm4gY2FjaGU7XG4gICAgICAgIH1cblxuICAgICAgICAvKipcbiAgICAgICAgICogdGhlIGRhdGFzZXQgd2lsbCBzdGFydCBsaXN0ZW5pbmcgdG8gdGhlIGRhdGFzdHJlYW0gXG4gICAgICAgICAqIFxuICAgICAgICAgKiBOb3RlIER1cmluZyB0aGUgc3luYywgaXQgd2lsbCBhbHNvIGNhbGwgdGhlIG9wdGlvbmFsIGNhbGxiYWNrcyAtIGFmdGVyIHByb2Nlc3NpbmcgRUFDSCByZWNvcmQgcmVjZWl2ZWQuXG4gICAgICAgICAqIFxuICAgICAgICAgKiBAcmV0dXJucyBhIHByb21pc2UgdGhhdCB3aWxsIGJlIHJlc29sdmVkIHdoZW4gdGhlIGRhdGEgaXMgcmVhZHkuXG4gICAgICAgICAqL1xuICAgICAgICBmdW5jdGlvbiBzeW5jT24oKSB7XG4gICAgICAgICAgICBpZiAoaXNTeW5jaW5nT24pIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gZGVmZXJyZWRJbml0aWFsaXphdGlvbi5wcm9taXNlO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgZGVmZXJyZWRJbml0aWFsaXphdGlvbiA9ICRxLmRlZmVyKCk7XG4gICAgICAgICAgICBpc0luaXRpYWxQdXNoQ29tcGxldGVkID0gZmFsc2U7XG4gICAgICAgICAgICBjb25zb2xlLmxvZygnU3luYyAnICsgcHVibGljYXRpb24gKyAnIG9uLiBQYXJhbXM6JyArIEpTT04uc3RyaW5naWZ5KHN1YlBhcmFtcykpO1xuICAgICAgICAgICAgaXNTeW5jaW5nT24gPSB0cnVlO1xuICAgICAgICAgICAgcmVnaXN0ZXJTdWJzY3JpcHRpb24oKTtcbiAgICAgICAgICAgIHJlYWR5Rm9yTGlzdGVuaW5nKCk7XG4gICAgICAgICAgICByZXR1cm4gZGVmZXJyZWRJbml0aWFsaXphdGlvbi5wcm9taXNlO1xuICAgICAgICB9XG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqIHRoZSBkYXRhc2V0IGlzIG5vIGxvbmdlciBsaXN0ZW5pbmcgYW5kIHdpbGwgbm90IGNhbGwgYW55IGNhbGxiYWNrXG4gICAgICAgICAqL1xuICAgICAgICBmdW5jdGlvbiBzeW5jT2ZmKCkge1xuICAgICAgICAgICAgaWYgKGRlZmVycmVkSW5pdGlhbGl6YXRpb24pIHtcbiAgICAgICAgICAgICAgICAvLyBpZiB0aGVyZSBpcyBjb2RlIHdhaXRpbmcgb24gdGhpcyBwcm9taXNlLi4gZXggKGxvYWQgaW4gcmVzb2x2ZSlcbiAgICAgICAgICAgICAgICBkZWZlcnJlZEluaXRpYWxpemF0aW9uLnJlc29sdmUoZ2V0RGF0YSgpKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChpc1N5bmNpbmdPbikge1xuICAgICAgICAgICAgICAgIHVucmVnaXN0ZXJTdWJzY3JpcHRpb24oKTtcbiAgICAgICAgICAgICAgICBpc1N5bmNpbmdPbiA9IGZhbHNlO1xuXG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2coJ1N5bmMgJyArIHB1YmxpY2F0aW9uICsgJyBvZmYuIFBhcmFtczonICsgSlNPTi5zdHJpbmdpZnkoc3ViUGFyYW1zKSk7XG4gICAgICAgICAgICAgICAgaWYgKHB1YmxpY2F0aW9uTGlzdGVuZXJPZmYpIHtcbiAgICAgICAgICAgICAgICAgICAgcHVibGljYXRpb25MaXN0ZW5lck9mZigpO1xuICAgICAgICAgICAgICAgICAgICBwdWJsaWNhdGlvbkxpc3RlbmVyT2ZmID0gbnVsbDtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgaWYgKHJlY29ubmVjdE9mZikge1xuICAgICAgICAgICAgICAgICAgICByZWNvbm5lY3RPZmYoKTtcbiAgICAgICAgICAgICAgICAgICAgcmVjb25uZWN0T2ZmID0gbnVsbDtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiBpc1N5bmNpbmcoKSB7XG4gICAgICAgICAgICByZXR1cm4gaXNTeW5jaW5nT247XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiByZWFkeUZvckxpc3RlbmluZygpIHtcbiAgICAgICAgICAgIGlmICghcHVibGljYXRpb25MaXN0ZW5lck9mZikge1xuICAgICAgICAgICAgICAgIGxpc3RlbkZvclJlY29ubmVjdGlvblRvUmVzeW5jKCk7XG4gICAgICAgICAgICAgICAgbGlzdGVuVG9QdWJsaWNhdGlvbigpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqICBCeSBkZWZhdWx0IHRoZSByb290c2NvcGUgaXMgYXR0YWNoZWQgaWYgbm8gc2NvcGUgd2FzIHByb3ZpZGVkLiBCdXQgaXQgaXMgcG9zc2libGUgdG8gcmUtYXR0YWNoIGl0IHRvIGEgZGlmZmVyZW50IHNjb3BlLiBpZiB0aGUgc3Vic2NyaXB0aW9uIGRlcGVuZHMgb24gYSBjb250cm9sbGVyLlxuICAgICAgICAgKlxuICAgICAgICAgKiAgRG8gbm90IGF0dGFjaCBhZnRlciBpdCBoYXMgc3luY2VkLlxuICAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gYXR0YWNoKG5ld1Njb3BlKSB7XG4gICAgICAgICAgICBpZiAoZGVmZXJyZWRJbml0aWFsaXphdGlvbikge1xuICAgICAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoZGVzdHJveU9mZikge1xuICAgICAgICAgICAgICAgIGRlc3Ryb3lPZmYoKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlubmVyU2NvcGUgPSBuZXdTY29wZTtcbiAgICAgICAgICAgIGRlc3Ryb3lPZmYgPSBpbm5lclNjb3BlLiRvbignJGRlc3Ryb3knLCBkZXN0cm95KTtcblxuICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIGxpc3RlbkZvclJlY29ubmVjdGlvblRvUmVzeW5jKGxpc3Rlbk5vdykge1xuICAgICAgICAgICAgLy8gZ2l2ZSBhIGNoYW5jZSB0byBjb25uZWN0IGJlZm9yZSBsaXN0ZW5pbmcgdG8gcmVjb25uZWN0aW9uLi4uIEBUT0RPIHNob3VsZCBoYXZlIHVzZXJfcmVjb25uZWN0ZWRfZXZlbnRcbiAgICAgICAgICAgIHNldFRpbWVvdXQoZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgIHJlY29ubmVjdE9mZiA9IGlubmVyU2NvcGUuJG9uKCd1c2VyX2Nvbm5lY3RlZCcsIGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICAgICAgY29uc29sZS5kZWJ1ZygnUmVzeW5jaW5nIGFmdGVyIG5ldHdvcmsgbG9zcyB0byAnICsgcHVibGljYXRpb24pO1xuICAgICAgICAgICAgICAgICAgICAvLyBub3RlIHRoZSBiYWNrZW5kIG1pZ2h0IHJldHVybiBhIG5ldyBzdWJzY3JpcHRpb24gaWYgdGhlIGNsaWVudCB0b29rIHRvbyBtdWNoIHRpbWUgdG8gcmVjb25uZWN0LlxuICAgICAgICAgICAgICAgICAgICByZWdpc3RlclN1YnNjcmlwdGlvbigpO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfSwgbGlzdGVuTm93ID8gMCA6IDIwMDApO1xuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gcmVnaXN0ZXJTdWJzY3JpcHRpb24oKSB7XG4gICAgICAgICAgICAkc29ja2V0aW8uZmV0Y2goJ3N5bmMuc3Vic2NyaWJlJywge1xuICAgICAgICAgICAgICAgIHZlcnNpb246IFNZTkNfVkVSU0lPTixcbiAgICAgICAgICAgICAgICBpZDogc3Vic2NyaXB0aW9uSWQsIC8vIHRvIHRyeSB0byByZS11c2UgZXhpc3Rpbmcgc3ViY3JpcHRpb25cbiAgICAgICAgICAgICAgICBwdWJsaWNhdGlvbjogcHVibGljYXRpb24sXG4gICAgICAgICAgICAgICAgcGFyYW1zOiBzdWJQYXJhbXNcbiAgICAgICAgICAgIH0pLnRoZW4oZnVuY3Rpb24gKHN1YklkKSB7XG4gICAgICAgICAgICAgICAgc3Vic2NyaXB0aW9uSWQgPSBzdWJJZDtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gdW5yZWdpc3RlclN1YnNjcmlwdGlvbigpIHtcbiAgICAgICAgICAgIGlmIChzdWJzY3JpcHRpb25JZCkge1xuICAgICAgICAgICAgICAgICRzb2NrZXRpby5mZXRjaCgnc3luYy51bnN1YnNjcmliZScsIHtcbiAgICAgICAgICAgICAgICAgICAgdmVyc2lvbjogU1lOQ19WRVJTSU9OLFxuICAgICAgICAgICAgICAgICAgICBpZDogc3Vic2NyaXB0aW9uSWRcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgICAgICBzdWJzY3JpcHRpb25JZCA9IG51bGw7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiBsaXN0ZW5Ub1B1YmxpY2F0aW9uKCkge1xuICAgICAgICAgICAgLy8gY2Fubm90IG9ubHkgbGlzdGVuIHRvIHN1YnNjcmlwdGlvbklkIHlldC4uLmJlY2F1c2UgdGhlIHJlZ2lzdHJhdGlvbiBtaWdodCBoYXZlIGFuc3dlciBwcm92aWRlZCBpdHMgaWQgeWV0Li4uYnV0IHN0YXJ0ZWQgYnJvYWRjYXN0aW5nIGNoYW5nZXMuLi5AVE9ETyBjYW4gYmUgaW1wcm92ZWQuLi5cbiAgICAgICAgICAgIHB1YmxpY2F0aW9uTGlzdGVuZXJPZmYgPSBhZGRQdWJsaWNhdGlvbkxpc3RlbmVyKHB1YmxpY2F0aW9uLCBmdW5jdGlvbiAoYmF0Y2gpIHtcbiAgICAgICAgICAgICAgICBpZiAoc3Vic2NyaXB0aW9uSWQgPT09IGJhdGNoLnN1YnNjcmlwdGlvbklkIHx8ICghc3Vic2NyaXB0aW9uSWQgJiYgY2hlY2tEYXRhU2V0UGFyYW1zSWZNYXRjaGluZ0JhdGNoUGFyYW1zKGJhdGNoLnBhcmFtcykpKSB7XG4gICAgICAgICAgICAgICAgICAgIGlmICghYmF0Y2guZGlmZikge1xuICAgICAgICAgICAgICAgICAgICAgICAgLy8gQ2xlYXIgdGhlIGNhY2hlIHRvIHJlYnVpbGQgaXQgaWYgYWxsIGRhdGEgd2FzIHJlY2VpdmVkLlxuICAgICAgICAgICAgICAgICAgICAgICAgcmVjb3JkU3RhdGVzID0ge307XG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoIWlzU2luZ2xlKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgY2FjaGUubGVuZ3RoID0gMDtcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICBhcHBseUNoYW5nZXMoYmF0Y2gucmVjb3Jkcyk7XG4gICAgICAgICAgICAgICAgICAgIGlmICghaXNJbml0aWFsUHVzaENvbXBsZXRlZCkge1xuICAgICAgICAgICAgICAgICAgICAgICAgaXNJbml0aWFsUHVzaENvbXBsZXRlZCA9IHRydWU7XG4gICAgICAgICAgICAgICAgICAgICAgICBkZWZlcnJlZEluaXRpYWxpemF0aW9uLnJlc29sdmUoZ2V0RGF0YSgpKTtcbiAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgLyoqXG4gICAgICAgICogaWYgdGhlIHBhcmFtcyBvZiB0aGUgZGF0YXNldCBtYXRjaGVzIHRoZSBub3RpZmljYXRpb24sIGl0IG1lYW5zIHRoZSBkYXRhIG5lZWRzIHRvIGJlIGNvbGxlY3QgdG8gdXBkYXRlIGFycmF5LlxuICAgICAgICAqL1xuICAgICAgICBmdW5jdGlvbiBjaGVja0RhdGFTZXRQYXJhbXNJZk1hdGNoaW5nQmF0Y2hQYXJhbXMoYmF0Y2hQYXJhbXMpIHtcbiAgICAgICAgICAgIC8vIGlmIChwYXJhbXMubGVuZ3RoICE9IHN0cmVhbVBhcmFtcy5sZW5ndGgpIHtcbiAgICAgICAgICAgIC8vICAgICByZXR1cm4gZmFsc2U7XG4gICAgICAgICAgICAvLyB9XG4gICAgICAgICAgICBpZiAoIXN1YlBhcmFtcyB8fCBPYmplY3Qua2V5cyhzdWJQYXJhbXMpLmxlbmd0aCA9PSAwKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHRydWVcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHZhciBtYXRjaGluZyA9IHRydWU7XG4gICAgICAgICAgICBmb3IgKHZhciBwYXJhbSBpbiBiYXRjaFBhcmFtcykge1xuICAgICAgICAgICAgICAgIC8vIGFyZSBvdGhlciBwYXJhbXMgbWF0Y2hpbmc/XG4gICAgICAgICAgICAgICAgLy8gZXg6IHdlIG1pZ2h0IGhhdmUgcmVjZWl2ZSBhIG5vdGlmaWNhdGlvbiBhYm91dCB0YXNrSWQ9MjAgYnV0IHRoaXMgc3Vic2NyaXB0aW9uIGFyZSBvbmx5IGludGVyZXN0ZWQgYWJvdXQgdGFza0lkLTNcbiAgICAgICAgICAgICAgICBpZiAoYmF0Y2hQYXJhbXNbcGFyYW1dICE9PSBzdWJQYXJhbXNbcGFyYW1dKSB7XG4gICAgICAgICAgICAgICAgICAgIGJyZWFrO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBtYXRjaGluZztcblxuICAgICAgICB9XG5cbiAgICAgICAgLy8gZmV0Y2ggYWxsIHRoZSBtaXNzaW5nIHJlY29yZHMsIGFuZCBhY3RpdmF0ZSB0aGUgY2FsbCBiYWNrcyAoYWRkLHVwZGF0ZSxyZW1vdmUpIGFjY29yZGluZ2x5IGlmIHRoZXJlIGlzIHNvbWV0aGluZyB0aGF0IGlzIG5ldyBvciBub3QgYWxyZWFkeSBpbiBzeW5jLlxuICAgICAgICBmdW5jdGlvbiBhcHBseUNoYW5nZXMocmVjb3Jkcykge1xuICAgICAgICAgICAgdmFyIG5ld0RhdGFBcnJheSA9IFtdO1xuICAgICAgICAgICAgdmFyIG5ld0RhdGE7XG4gICAgICAgICAgICBzRHMucmVhZHkgPSBmYWxzZTtcbiAgICAgICAgICAgIHJlY29yZHMuZm9yRWFjaChmdW5jdGlvbiAocmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgLy8gICAgICAgICAgICAgICAgICAgY29uc29sZS5sb2coJ0RhdGFzeW5jIFsnICsgZGF0YVN0cmVhbU5hbWUgKyAnXSByZWNlaXZlZDonICtKU09OLnN0cmluZ2lmeShyZWNvcmQpKTsvLysgcmVjb3JkLmlkKTtcbiAgICAgICAgICAgICAgICBpZiAocmVjb3JkLnJlbW92ZSkge1xuICAgICAgICAgICAgICAgICAgICByZW1vdmVSZWNvcmQocmVjb3JkKTtcbiAgICAgICAgICAgICAgICB9IGVsc2UgaWYgKHJlY29yZFN0YXRlc1tyZWNvcmQuaWRdKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vIGlmIHRoZSByZWNvcmQgaXMgYWxyZWFkeSBwcmVzZW50IGluIHRoZSBjYWNoZS4uLnNvIGl0IGlzIG1pZ2h0YmUgYW4gdXBkYXRlLi5cbiAgICAgICAgICAgICAgICAgICAgbmV3RGF0YSA9IHVwZGF0ZVJlY29yZChyZWNvcmQpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgICAgIG5ld0RhdGEgPSBhZGRSZWNvcmQocmVjb3JkKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgaWYgKG5ld0RhdGEpIHtcbiAgICAgICAgICAgICAgICAgICAgbmV3RGF0YUFycmF5LnB1c2gobmV3RGF0YSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICBzRHMucmVhZHkgPSB0cnVlO1xuICAgICAgICAgICAgaWYgKGlzU2luZ2xlKSB7XG4gICAgICAgICAgICAgICAgc3luY0xpc3RlbmVyLm5vdGlmeSgncmVhZHknLCBnZXREYXRhKCkpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBzeW5jTGlzdGVuZXIubm90aWZ5KCdyZWFkeScsIGdldERhdGEoKSwgbmV3RGF0YUFycmF5KTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiBBbHRob3VnaCBtb3N0IGNhc2VzIGFyZSBoYW5kbGVkIHVzaW5nIG9uUmVhZHksIHRoaXMgdGVsbHMgeW91IHRoZSBjdXJyZW50IGRhdGEgc3RhdGUuXG4gICAgICAgICAqIFxuICAgICAgICAgKiBAcmV0dXJucyBpZiB0cnVlIGlzIGEgc3luYyBoYXMgYmVlbiBwcm9jZXNzZWQgb3RoZXJ3aXNlIGZhbHNlIGlmIHRoZSBkYXRhIGlzIG5vdCByZWFkeS5cbiAgICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIGlzUmVhZHkoKSB7XG4gICAgICAgICAgICByZXR1cm4gdGhpcy5yZWFkeTtcbiAgICAgICAgfVxuICAgICAgICAvKipcbiAgICAgICAgICogXG4gICAgICAgICAqIHJldHVybnMgYSBmdW5jdGlvbiB0byByZW1vdmUgdGhlIGxpc3RlbmVyLlxuICAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gb25BZGQoY2FsbGJhY2spIHtcbiAgICAgICAgICAgIHJldHVybiBzeW5jTGlzdGVuZXIub24oJ2FkZCcsIGNhbGxiYWNrKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiBcbiAgICAgICAgICogcmV0dXJucyBhIGZ1bmN0aW9uIHRvIHJlbW92ZSB0aGUgbGlzdGVuZXIuXG4gICAgICAgICAqL1xuICAgICAgICBmdW5jdGlvbiBvblVwZGF0ZShjYWxsYmFjaykge1xuICAgICAgICAgICAgcmV0dXJuIHN5bmNMaXN0ZW5lci5vbigndXBkYXRlJywgY2FsbGJhY2spO1xuICAgICAgICB9XG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqIFxuICAgICAgICAgKiByZXR1cm5zIGEgZnVuY3Rpb24gdG8gcmVtb3ZlIHRoZSBsaXN0ZW5lci5cbiAgICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIG9uUmVtb3ZlKGNhbGxiYWNrKSB7XG4gICAgICAgICAgICByZXR1cm4gc3luY0xpc3RlbmVyLm9uKCdyZW1vdmUnLCBjYWxsYmFjayk7XG4gICAgICAgIH1cblxuICAgICAgICAvKipcbiAgICAgICAgICogXG4gICAgICAgICAqIHJldHVybnMgYSBmdW5jdGlvbiB0byByZW1vdmUgdGhlIGxpc3RlbmVyLlxuICAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gb25SZWFkeShjYWxsYmFjaykge1xuICAgICAgICAgICAgcmV0dXJuIHN5bmNMaXN0ZW5lci5vbigncmVhZHknLCBjYWxsYmFjayk7XG4gICAgICAgIH1cblxuXG4gICAgICAgIGZ1bmN0aW9uIGFkZFJlY29yZChyZWNvcmQpIHtcbiAgICAgICAgICAgIGNvbnNvbGUuZGVidWcoJ1N5bmMgLT4gSW5zZXJ0ZWQgTmV3IHJlY29yZCAjJyArIHJlY29yZC5pZCArICcgZm9yIHN1YnNjcmlwdGlvbiB0byAnICsgcHVibGljYXRpb24pOy8vIEpTT04uc3RyaW5naWZ5KHJlY29yZCkpO1xuICAgICAgICAgICAgZ2V0UmV2aXNpb24ocmVjb3JkKTsgLy8ganVzdCBtYWtlIHN1cmUgd2UgY2FuIGdldCBhIHJldmlzaW9uIGJlZm9yZSB3ZSBoYW5kbGUgdGhpcyByZWNvcmRcbiAgICAgICAgICAgIHVwZGF0ZURhdGFTdG9yYWdlKGZvcm1hdFJlY29yZCA/IGZvcm1hdFJlY29yZChyZWNvcmQpIDogcmVjb3JkKTtcbiAgICAgICAgICAgIHN5bmNMaXN0ZW5lci5ub3RpZnkoJ2FkZCcsIHJlY29yZCk7XG4gICAgICAgICAgICByZXR1cm4gcmVjb3JkO1xuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gdXBkYXRlUmVjb3JkKHJlY29yZCkge1xuICAgICAgICAgICAgdmFyIHByZXZpb3VzID0gcmVjb3JkU3RhdGVzW3JlY29yZC5pZF07XG4gICAgICAgICAgICBpZiAoZ2V0UmV2aXNpb24ocmVjb3JkKSA8PSBnZXRSZXZpc2lvbihwcmV2aW91cykpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gbnVsbDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGNvbnNvbGUuZGVidWcoJ1N5bmMgLT4gVXBkYXRlZCByZWNvcmQgIycgKyByZWNvcmQuaWQgKyAnIGZvciBzdWJzY3JpcHRpb24gdG8gJyArIHB1YmxpY2F0aW9uKTsvLyBKU09OLnN0cmluZ2lmeShyZWNvcmQpKTtcbiAgICAgICAgICAgIHVwZGF0ZURhdGFTdG9yYWdlKGZvcm1hdFJlY29yZCA/IGZvcm1hdFJlY29yZChyZWNvcmQpIDogcmVjb3JkKTtcbiAgICAgICAgICAgIHN5bmNMaXN0ZW5lci5ub3RpZnkoJ3VwZGF0ZScsIHJlY29yZCk7XG4gICAgICAgICAgICByZXR1cm4gcmVjb3JkO1xuICAgICAgICB9XG5cblxuICAgICAgICBmdW5jdGlvbiByZW1vdmVSZWNvcmQocmVjb3JkKSB7XG4gICAgICAgICAgICB2YXIgcHJldmlvdXMgPSByZWNvcmRTdGF0ZXNbcmVjb3JkLmlkXTtcbiAgICAgICAgICAgIGlmICghcHJldmlvdXMgfHwgZ2V0UmV2aXNpb24ocmVjb3JkKSA+IGdldFJldmlzaW9uKHByZXZpb3VzKSkge1xuICAgICAgICAgICAgICAgIGNvbnNvbGUuZGVidWcoJ1N5bmMgLT4gUmVtb3ZlZCAjJyArIHJlY29yZC5pZCArICcgZm9yIHN1YnNjcmlwdGlvbiB0byAnICsgcHVibGljYXRpb24pO1xuICAgICAgICAgICAgICAgIC8vIFdlIGNvdWxkIGhhdmUgZm9yIHRoZSBzYW1lIHJlY29yZCBjb25zZWN1dGl2ZWx5IGZldGNoaW5nIGluIHRoaXMgb3JkZXI6XG4gICAgICAgICAgICAgICAgLy8gZGVsZXRlIGlkOjQsIHJldiAxMCwgdGhlbiBhZGQgaWQ6NCwgcmV2IDkuLi4uIGJ5IGtlZXBpbmcgdHJhY2sgb2Ygd2hhdCB3YXMgZGVsZXRlZCwgd2Ugd2lsbCBub3QgYWRkIHRoZSByZWNvcmQgc2luY2UgaXQgd2FzIGRlbGV0ZWQgd2l0aCBhIG1vc3QgcmVjZW50IHRpbWVzdGFtcC5cbiAgICAgICAgICAgICAgICByZWNvcmQucmVtb3ZlZCA9IHRydWU7IC8vIFNvIHdlIG9ubHkgZmxhZyBhcyByZW1vdmVkLCBsYXRlciBvbiB0aGUgZ2FyYmFnZSBjb2xsZWN0b3Igd2lsbCBnZXQgcmlkIG9mIGl0LiAgICAgICAgIFxuICAgICAgICAgICAgICAgIHVwZGF0ZURhdGFTdG9yYWdlKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgLy8gaWYgdGhlcmUgaXMgbm8gcHJldmlvdXMgcmVjb3JkIHdlIGRvIG5vdCBuZWVkIHRvIHJlbW92ZWQgYW55IHRoaW5nIGZyb20gb3VyIHN0b3JhZ2UuICAgICBcbiAgICAgICAgICAgICAgICBpZiAocHJldmlvdXMpIHtcbiAgICAgICAgICAgICAgICAgICAgc3luY0xpc3RlbmVyLm5vdGlmeSgncmVtb3ZlJywgcmVjb3JkKTtcbiAgICAgICAgICAgICAgICAgICAgZGlzcG9zZShyZWNvcmQpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgICAgICBmdW5jdGlvbiBkaXNwb3NlKHJlY29yZCkge1xuICAgICAgICAgICAgJHN5bmNHYXJiYWdlQ29sbGVjdG9yLmRpc3Bvc2UoZnVuY3Rpb24gY29sbGVjdCgpIHtcbiAgICAgICAgICAgICAgICB2YXIgZXhpc3RpbmdSZWNvcmQgPSByZWNvcmRTdGF0ZXNbcmVjb3JkLmlkXTtcbiAgICAgICAgICAgICAgICBpZiAoZXhpc3RpbmdSZWNvcmQgJiYgcmVjb3JkLnJldmlzaW9uID49IGV4aXN0aW5nUmVjb3JkLnJldmlzaW9uXG4gICAgICAgICAgICAgICAgKSB7XG4gICAgICAgICAgICAgICAgICAgIC8vY29uc29sZS5kZWJ1ZygnQ29sbGVjdCBOb3c6JyArIEpTT04uc3RyaW5naWZ5KHJlY29yZCkpO1xuICAgICAgICAgICAgICAgICAgICBkZWxldGUgcmVjb3JkU3RhdGVzW3JlY29yZC5pZF07XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiBpc0V4aXN0aW5nU3RhdGVGb3IocmVjb3JkSWQpIHtcbiAgICAgICAgICAgIHJldHVybiAhIXJlY29yZFN0YXRlc1tyZWNvcmRJZF07XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiB1cGRhdGVTeW5jZWRPYmplY3QocmVjb3JkKSB7XG4gICAgICAgICAgICByZWNvcmRTdGF0ZXNbcmVjb3JkLmlkXSA9IHJlY29yZDtcbiAgICAgICAgICAgIGNsZWFyT2JqZWN0KGNhY2hlKTtcbiAgICAgICAgICAgIGlmICghcmVjb3JkLnJlbW92ZSkge1xuICAgICAgICAgICAgICAgIGFuZ3VsYXIuZXh0ZW5kKGNhY2hlLCByZWNvcmQpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gdXBkYXRlU3luY2VkQXJyYXkocmVjb3JkKSB7XG4gICAgICAgICAgICB2YXIgZXhpc3RpbmcgPSByZWNvcmRTdGF0ZXNbcmVjb3JkLmlkXTtcbiAgICAgICAgICAgIGlmICghZXhpc3RpbmcpIHtcbiAgICAgICAgICAgICAgICAvLyBhZGQgbmV3IGluc3RhbmNlXG4gICAgICAgICAgICAgICAgcmVjb3JkU3RhdGVzW3JlY29yZC5pZF0gPSByZWNvcmQ7XG4gICAgICAgICAgICAgICAgaWYgKCFyZWNvcmQucmVtb3ZlZCkge1xuICAgICAgICAgICAgICAgICAgICBjYWNoZS5wdXNoKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAvLyB1cGRhdGUgdGhlIGluc3RhbmNlXG4gICAgICAgICAgICAgICAgY2xlYXJPYmplY3QoZXhpc3RpbmcpO1xuICAgICAgICAgICAgICAgIGFuZ3VsYXIuZXh0ZW5kKGV4aXN0aW5nLCByZWNvcmQpO1xuICAgICAgICAgICAgICAgIGlmIChyZWNvcmQucmVtb3ZlZCkge1xuICAgICAgICAgICAgICAgICAgICBjYWNoZS5zcGxpY2UoY2FjaGUuaW5kZXhPZihleGlzdGluZyksIDEpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIGNsZWFyT2JqZWN0KG9iamVjdCkge1xuICAgICAgICAgICAgT2JqZWN0LmtleXMob2JqZWN0KS5mb3JFYWNoKGZ1bmN0aW9uIChrZXkpIHsgZGVsZXRlIG9iamVjdFtrZXldOyB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIGdldFJldmlzaW9uKHJlY29yZCkge1xuICAgICAgICAgICAgLy8gd2hhdCByZXNlcnZlZCBmaWVsZCBkbyB3ZSB1c2UgYXMgdGltZXN0YW1wXG4gICAgICAgICAgICBpZiAoYW5ndWxhci5pc0RlZmluZWQocmVjb3JkLnJldmlzaW9uKSkge1xuICAgICAgICAgICAgICAgIHJldHVybiByZWNvcmQucmV2aXNpb247XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoYW5ndWxhci5pc0RlZmluZWQocmVjb3JkLnRpbWVzdGFtcCkpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gcmVjb3JkLnRpbWVzdGFtcDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHRocm93IG5ldyBFcnJvcignU3luYyByZXF1aXJlcyBhIHJldmlzaW9uIG9yIHRpbWVzdGFtcCBwcm9wZXJ0eSBpbiByZWNlaXZlZCAnICsgKG9iamVjdENsYXNzID8gJ29iamVjdCBbJyArIG9iamVjdENsYXNzLm5hbWUgKyAnXScgOiAncmVjb3JkJykpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogdGhpcyBvYmplY3QgXG4gICAgICovXG4gICAgZnVuY3Rpb24gU3luY0xpc3RlbmVyKCkge1xuICAgICAgICB2YXIgZXZlbnRzID0ge307XG4gICAgICAgIHZhciBjb3VudCA9IDA7XG5cbiAgICAgICAgdGhpcy5ub3RpZnkgPSBub3RpZnk7XG4gICAgICAgIHRoaXMub24gPSBvbjtcblxuICAgICAgICBmdW5jdGlvbiBub3RpZnkoZXZlbnQsIGRhdGExLCBkYXRhMikge1xuICAgICAgICAgICAgdmFyIGxpc3RlbmVycyA9IGV2ZW50c1tldmVudF07XG4gICAgICAgICAgICBpZiAobGlzdGVuZXJzKSB7XG4gICAgICAgICAgICAgICAgXy5mb3JFYWNoKGxpc3RlbmVycywgZnVuY3Rpb24gKGNhbGxiYWNrLCBpZCkge1xuICAgICAgICAgICAgICAgICAgICBjYWxsYmFjayhkYXRhMSwgZGF0YTIpO1xuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqIEByZXR1cm5zIGhhbmRsZXIgdG8gdW5yZWdpc3RlciBsaXN0ZW5lclxuICAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gb24oZXZlbnQsIGNhbGxiYWNrKSB7XG4gICAgICAgICAgICB2YXIgbGlzdGVuZXJzID0gZXZlbnRzW2V2ZW50XTtcbiAgICAgICAgICAgIGlmICghbGlzdGVuZXJzKSB7XG4gICAgICAgICAgICAgICAgbGlzdGVuZXJzID0gZXZlbnRzW2V2ZW50XSA9IHt9O1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdmFyIGlkID0gY291bnQrKztcbiAgICAgICAgICAgIGxpc3RlbmVyc1tpZCsrXSA9IGNhbGxiYWNrO1xuICAgICAgICAgICAgcmV0dXJuIGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICBkZWxldGUgbGlzdGVuZXJzW2lkXTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuICAgIH1cbiAgICBmdW5jdGlvbiBnZXRDb25zb2xlKCkge1xuICAgICAgICAvLyB0byBoZWxwIHdpdGggZGVidWdnaW5nIGZvciBub3cgdW50aWwgd2Ugb3B0IGZvciBhIG5pY2UgbG9nZ2VyLiBJbiBwcm9kdWN0aW9uLCBsb2cgYW5kIGRlYnVnIHNob3VsZCBhdXRvbWF0aWNhbGx5IGJlIHJlbW92ZWQgYnkgdGhlIGJ1aWxkIGZyb20gdGhlIGNvZGUuLi4uIFRPRE86bmVlZCB0byBjaGVjayBvdXQgdGhlIHByb2R1Y3Rpb24gY29kZVxuICAgICAgICByZXR1cm4ge1xuICAgICAgICAgICAgbG9nOiBmdW5jdGlvbiAobXNnKSB7XG4gICAgICAgICAgICAgICAgd2luZG93LmNvbnNvbGUuZGVidWcoJ1NZTkMoaW5mbyk6ICcgKyBtc2cpO1xuICAgICAgICAgICAgfSxcbiAgICAgICAgICAgIGRlYnVnOiBmdW5jdGlvbiAobXNnKSB7XG4gICAgICAgICAgICAgICAgLy8gIHdpbmRvdy5jb25zb2xlLmRlYnVnKCdTWU5DKGRlYnVnKTogJyArIG1zZyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH07XG4gICAgfVxufTtcbn0oKSk7XG5cbiIsImFuZ3VsYXJcbiAgICAubW9kdWxlKCdzeW5jJywgWydzb2NrZXRpby1hdXRoJ10pXG4gICAgLmNvbmZpZyhmdW5jdGlvbigkc29ja2V0aW9Qcm92aWRlcil7XG4gICAgICAgICRzb2NrZXRpb1Byb3ZpZGVyLnNldERlYnVnKHRydWUpO1xuICAgIH0pO1xuIiwiYW5ndWxhclxuICAgIC5tb2R1bGUoJ3N5bmMnKVxuICAgIC5mYWN0b3J5KCckc3luY0dhcmJhZ2VDb2xsZWN0b3InLCBzeW5jR2FyYmFnZUNvbGxlY3Rvcik7XG5cbi8qKlxuICogc2FmZWx5IHJlbW92ZSBkZWxldGVkIHJlY29yZC9vYmplY3QgZnJvbSBtZW1vcnkgYWZ0ZXIgdGhlIHN5bmMgcHJvY2VzcyBkaXNwb3NlZCB0aGVtLlxuICogXG4gKiBUT0RPOiBTZWNvbmRzIHNob3VsZCByZWZsZWN0IHRoZSBtYXggdGltZSAgdGhhdCBzeW5jIGNhY2hlIGlzIHZhbGlkIChuZXR3b3JrIGxvc3Mgd291bGQgZm9yY2UgYSByZXN5bmMpLCB3aGljaCBzaG91bGQgbWF0Y2ggbWF4RGlzY29ubmVjdGlvblRpbWVCZWZvcmVEcm9wcGluZ1N1YnNjcmlwdGlvbiBvbiB0aGUgc2VydmVyIHNpZGUuXG4gKiBcbiAqIE5vdGU6XG4gKiByZW1vdmVkIHJlY29yZCBzaG91bGQgYmUgZGVsZXRlZCBmcm9tIHRoZSBzeW5jIGludGVybmFsIGNhY2hlIGFmdGVyIGEgd2hpbGUgc28gdGhhdCB0aGV5IGRvIG5vdCBzdGF5IGluIHRoZSBtZW1vcnkuIFRoZXkgY2Fubm90IGJlIHJlbW92ZWQgdG9vIGVhcmx5IGFzIGFuIG9sZGVyIHZlcnNpb24vc3RhbXAgb2YgdGhlIHJlY29yZCBjb3VsZCBiZSByZWNlaXZlZCBhZnRlciBpdHMgcmVtb3ZhbC4uLndoaWNoIHdvdWxkIHJlLWFkZCB0byBjYWNoZS4uLmR1ZSBhc3luY2hyb25vdXMgcHJvY2Vzc2luZy4uLlxuICovXG5mdW5jdGlvbiBzeW5jR2FyYmFnZUNvbGxlY3RvcigpIHtcbiAgICB2YXIgaXRlbXMgPSBbXTtcbiAgICB2YXIgc2Vjb25kcyA9IDI7XG4gICAgdmFyIHNjaGVkdWxlZCA9IGZhbHNlO1xuXG4gICAgdmFyIHNlcnZpY2UgPSB7XG4gICAgICAgIHNldFNlY29uZHM6IHNldFNlY29uZHMsXG4gICAgICAgIGdldFNlY29uZHM6IGdldFNlY29uZHMsXG4gICAgICAgIGRpc3Bvc2U6IGRpc3Bvc2UsXG4gICAgICAgIHNjaGVkdWxlOiBzY2hlZHVsZSxcbiAgICAgICAgcnVuOiBydW4sXG4gICAgICAgIGdldEl0ZW1Db3VudDogZ2V0SXRlbUNvdW50XG4gICAgfTtcblxuICAgIHJldHVybiBzZXJ2aWNlO1xuXG4gICAgLy8vLy8vLy8vL1xuXG4gICAgZnVuY3Rpb24gc2V0U2Vjb25kcyh2YWx1ZSkge1xuICAgICAgICBzZWNvbmRzID0gdmFsdWU7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gZ2V0U2Vjb25kcygpIHtcbiAgICAgICAgcmV0dXJuIHNlY29uZHM7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gZ2V0SXRlbUNvdW50KCkge1xuICAgICAgICByZXR1cm4gaXRlbXMubGVuZ3RoO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIGRpc3Bvc2UoY29sbGVjdCkge1xuICAgICAgICBpdGVtcy5wdXNoKHtcbiAgICAgICAgICAgIHRpbWVzdGFtcDogRGF0ZS5ub3coKSxcbiAgICAgICAgICAgIGNvbGxlY3Q6IGNvbGxlY3RcbiAgICAgICAgfSk7XG4gICAgICAgIGlmICghc2NoZWR1bGVkKSB7XG4gICAgICAgICAgICBzZXJ2aWNlLnNjaGVkdWxlKCk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICBmdW5jdGlvbiBzY2hlZHVsZSgpIHtcbiAgICAgICAgaWYgKCFzZWNvbmRzKSB7XG4gICAgICAgICAgICBzZXJ2aWNlLnJ1bigpO1xuICAgICAgICAgICAgcmV0dXJuO1xuICAgICAgICB9XG4gICAgICAgIHNjaGVkdWxlZCA9IHRydWU7XG4gICAgICAgIHNldFRpbWVvdXQoZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgc2VydmljZS5ydW4oKTtcbiAgICAgICAgICAgIGlmIChpdGVtcy5sZW5ndGggPiAwKSB7XG4gICAgICAgICAgICAgICAgc2NoZWR1bGUoKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgc2NoZWR1bGVkID0gZmFsc2U7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0sIHNlY29uZHMgKiAxMDAwKTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBydW4oKSB7XG4gICAgICAgIHZhciB0aW1lb3V0ID0gRGF0ZS5ub3coKSAtIHNlY29uZHMgKiAxMDAwO1xuICAgICAgICB3aGlsZSAoaXRlbXMubGVuZ3RoID4gMCAmJiBpdGVtc1swXS50aW1lc3RhbXAgPD0gdGltZW91dCkge1xuICAgICAgICAgICAgaXRlbXMuc2hpZnQoKS5jb2xsZWN0KCk7XG4gICAgICAgIH1cbiAgICB9XG59XG5cblxuIiwiXG4vKipcbiAqIFxuICogU2VydmljZSB0aGF0IGFsbG93cyBhbiBhcnJheSBvZiBkYXRhIHJlbWFpbiBpbiBzeW5jIHdpdGggYmFja2VuZC5cbiAqIFxuICogSWYgbmV0d29yayBpcyBsb3N0LCB3ZSBsb2FkIHdoYXQgd2UgbWlzc2VkIHRoYW5rcyB0byB0aGUgdGltZXN0YW1wLi5cbiAqIFxuICogZXg6XG4gKiB3aGVuIHRoZXJlIGlzIGEgbm90aWZpY2F0aW9uLCBub3RpY2F0aW9uU2VydmljZSBub3RpZmllcyB0aGF0IHRoZXJlIGlzIHNvbWV0aGluZyBuZXcuLi50aGVuIHRoZSBkYXRhc2V0IGdldCB0aGUgZGF0YSBhbmQgbm90aWZpZXMgYWxsIGl0cyBjYWxsYmFjay5cbiAqIFxuICogTk9URTogXG4gKiAgXG4gKiBcbiAqIFByZS1SZXF1aXN0ZTpcbiAqIC0tLS0tLS0tLS0tLS1cbiAqIFN5bmMgZG9lcyBub3Qgd29yayBpZiBvYmplY3RzIGRvIG5vdCBoYXZlIEJPVEggaWQgYW5kIHJldmlzaW9uIGZpZWxkISEhIVxuICogXG4gKiBXaGVuIHRoZSBiYWNrZW5kIHdyaXRlcyBhbnkgZGF0YSB0byB0aGUgZGIgdGhhdCBhcmUgc3VwcG9zZWQgdG8gYmUgc3luY3Jvbml6ZWQ6XG4gKiBJdCBtdXN0IG1ha2Ugc3VyZSBlYWNoIGFkZCwgdXBkYXRlLCByZW1vdmFsIG9mIHJlY29yZCBpcyB0aW1lc3RhbXBlZC5cbiAqIEl0IG11c3Qgbm90aWZ5IHRoZSBkYXRhc3RyZWFtICh3aXRoIG5vdGlmeUNoYW5nZSBvciBub3RpZnlSZW1vdmFsKSB3aXRoIHNvbWUgcGFyYW1zIHNvIHRoYXQgYmFja2VuZCBrbm93cyB0aGF0IGl0IGhhcyB0byBwdXNoIGJhY2sgdGhlIGRhdGEgYmFjayB0byB0aGUgc3Vic2NyaWJlcnMgKGV4OiB0aGUgdGFza0NyZWF0aW9uIHdvdWxkIG5vdGlmeSB3aXRoIGl0cyBwbGFuSWQpXG4qIFxuICogXG4gKi9cbmFuZ3VsYXJcbiAgICAubW9kdWxlKCdzeW5jJylcbiAgICAuZmFjdG9yeSgnJHN5bmMnLCBzeW5jKTtcblxuZnVuY3Rpb24gc3luYygkcm9vdFNjb3BlLCAkcSwgJHNvY2tldGlvLCAkc3luY0dhcmJhZ2VDb2xsZWN0b3IpIHtcbiAgICB2YXIgcHVibGljYXRpb25MaXN0ZW5lcnMgPSB7fSxcbiAgICAgICAgcHVibGljYXRpb25MaXN0ZW5lckNvdW50ID0gMDtcbiAgICB2YXIgR1JBQ0VfUEVSSU9EX0lOX1NFQ09ORFMgPSA4O1xuICAgIHZhciBTWU5DX1ZFUlNJT04gPSAnMS4wJztcbiAgICB2YXIgY29uc29sZSA9IGdldENvbnNvbGUoKTtcblxuICAgIGxpc3RlblRvU3luY05vdGlmaWNhdGlvbigpO1xuXG4gICAgdmFyIHNlcnZpY2UgPSB7XG4gICAgICAgIHN1YnNjcmliZTogc3Vic2NyaWJlLFxuICAgICAgICByZXNvbHZlU3Vic2NyaXB0aW9uOiByZXNvbHZlU3Vic2NyaXB0aW9uLFxuICAgICAgICBnZXRHcmFjZVBlcmlvZDogZ2V0R3JhY2VQZXJpb2RcbiAgICB9O1xuXG4gICAgcmV0dXJuIHNlcnZpY2U7XG5cbiAgICAvLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vL1xuICAgIC8qKlxuICAgICAqIHN1YnNjcmliZSB0byBwdWJsaWNhdGlvbiBhbmQgcmV0dXJucyB0aGUgc3Vic2NyaXB0aW9uIHdoZW4gZGF0YSBpcyBhdmFpbGFibGUuIFxuICAgICAqIEBwYXJhbSBwdWJsaWNhdGlvbiBuYW1lLiBvbiB0aGUgc2VydmVyIHNpZGUsIGEgcHVibGljYXRpb24gc2hhbGwgZXhpc3QuIGV4OiBtYWdhemluZXMuc3luY1xuICAgICAqIEBwYXJhbSBwYXJhbXMgICB0aGUgcGFyYW1zIG9iamVjdCBwYXNzZWQgdG8gdGhlIHN1YnNjcmlwdGlvbiwgZXg6IHttYWdhemluZUlkOidlbnRyZXByZW5ldXInfSlcbiAgICAgKiBAcGFyYW0gb2JqZWN0Q2xhc3MgYW4gaW5zdGFuY2Ugb2YgdGhpcyBjbGFzcyB3aWxsIGJlIGNyZWF0ZWQgZm9yIGVhY2ggcmVjb3JkIHJlY2VpdmVkLlxuICAgICAqIHJldHVybnMgYSBwcm9taXNlIHJldHVybmluZyB0aGUgc3Vic2NyaXB0aW9uIHdoZW4gdGhlIGRhdGEgaXMgc3luY2VkXG4gICAgICogb3IgcmVqZWN0cyBpZiB0aGUgaW5pdGlhbCBzeW5jIGZhaWxzIHRvIGNvbXBsZXRlIGluIGEgbGltaXRlZCBhbW91bnQgb2YgdGltZS4gXG4gICAgICogXG4gICAgICogdG8gZ2V0IHRoZSBkYXRhIGZyb20gdGhlIGRhdGFTZXQsIGp1c3QgZGF0YVNldC5nZXREYXRhKClcbiAgICAgKi9cbiAgICBmdW5jdGlvbiByZXNvbHZlU3Vic2NyaXB0aW9uKHB1YmxpY2F0aW9uTmFtZSwgcGFyYW1zLCBvYmplY3RDbGFzcykge1xuICAgICAgICB2YXIgZGVmZXJyZWQgPSAkcS5kZWZlcigpO1xuICAgICAgICB2YXIgc0RzID0gc3Vic2NyaWJlKHB1YmxpY2F0aW9uTmFtZSkuc2V0T2JqZWN0Q2xhc3Mob2JqZWN0Q2xhc3MpO1xuXG4gICAgICAgIC8vIGdpdmUgYSBsaXR0bGUgdGltZSBmb3Igc3Vic2NyaXB0aW9uIHRvIGZldGNoIHRoZSBkYXRhLi4ub3RoZXJ3aXNlIGdpdmUgdXAgc28gdGhhdCB3ZSBkb24ndCBnZXQgc3R1Y2sgaW4gYSByZXNvbHZlIHdhaXRpbmcgZm9yZXZlci5cbiAgICAgICAgdmFyIGdyYWNlUGVyaW9kID0gc2V0VGltZW91dChmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICBpZiAoIXNEcy5yZWFkeSkge1xuICAgICAgICAgICAgICAgIHNEcy5kZXN0cm95KCk7XG4gICAgICAgICAgICAgICAgY29uc29sZS5sb2coJ0F0dGVtcHQgdG8gc3Vic2NyaWJlIHRvIHB1YmxpY2F0aW9uICcgKyBwdWJsaWNhdGlvbk5hbWUgKyAnIGZhaWxlZCcpO1xuICAgICAgICAgICAgICAgIGRlZmVycmVkLnJlamVjdCgnU1lOQ19USU1FT1VUJyk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH0sIEdSQUNFX1BFUklPRF9JTl9TRUNPTkRTICogMTAwMCk7XG5cbiAgICAgICAgc0RzLnNldFBhcmFtZXRlcnMocGFyYW1zKVxuICAgICAgICAgICAgLndhaXRGb3JEYXRhUmVhZHkoKVxuICAgICAgICAgICAgLnRoZW4oZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgIGNsZWFyVGltZW91dChncmFjZVBlcmlvZCk7XG4gICAgICAgICAgICAgICAgZGVmZXJyZWQucmVzb2x2ZShzRHMpO1xuICAgICAgICAgICAgfSkuY2F0Y2goZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgIGNsZWFyVGltZW91dChncmFjZVBlcmlvZCk7XG4gICAgICAgICAgICAgICAgc0RzLmRlc3Ryb3koKTtcbiAgICAgICAgICAgICAgICBkZWZlcnJlZC5yZWplY3QoJ0ZhaWxlZCB0byBzdWJzY3JpYmUgdG8gcHVibGljYXRpb24gJyArIHB1YmxpY2F0aW9uTmFtZSArICcgZmFpbGVkJyk7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgcmV0dXJuIGRlZmVycmVkLnByb21pc2U7XG4gICAgfVxuXG4gICAgLyoqXG4gICAgICogXG4gICAgICogZm9yIHRlc3QgcHVycG9zZXMsIHJldHVybnMgdGhlIHRpbWUgcmVzb2x2ZVN1YnNjcmlwdGlvbiBiZWZvcmUgaXQgdGltZXMgb3V0LlxuICAgICAqL1xuICAgIGZ1bmN0aW9uIGdldEdyYWNlUGVyaW9kKCkge1xuICAgICAgICByZXR1cm4gR1JBQ0VfUEVSSU9EX0lOX1NFQ09ORFM7XG4gICAgfVxuICAgIC8qKlxuICAgICAqIHN1YnNjcmliZSB0byBwdWJsaWNhdGlvbi4gSXQgd2lsbCBub3Qgc3luYyB1bnRpbCB5b3Ugc2V0IHRoZSBwYXJhbXMuXG4gICAgICogXG4gICAgICogQHBhcmFtIHB1YmxpY2F0aW9uIG5hbWUuIG9uIHRoZSBzZXJ2ZXIgc2lkZSwgYSBwdWJsaWNhdGlvbiBzaGFsbCBleGlzdC4gZXg6IG1hZ2F6aW5lcy5zeW5jXG4gICAgICogQHBhcmFtIHBhcmFtcyAgIHRoZSBwYXJhbXMgb2JqZWN0IHBhc3NlZCB0byB0aGUgc3Vic2NyaXB0aW9uLCBleDoge21hZ2F6aW5lSWQ6J2VudHJlcHJlbmV1cid9KVxuICAgICAqIHJldHVybnMgc3Vic2NyaXB0aW9uXG4gICAgICogXG4gICAgICovXG4gICAgZnVuY3Rpb24gc3Vic2NyaWJlKHB1YmxpY2F0aW9uTmFtZSwgc2NvcGUpIHtcbiAgICAgICAgcmV0dXJuIG5ldyBTdWJzY3JpcHRpb24ocHVibGljYXRpb25OYW1lLCBzY29wZSk7XG4gICAgfVxuXG5cblxuICAgIC8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vXG4gICAgLy8gSEVMUEVSU1xuXG4gICAgLy8gZXZlcnkgc3luYyBub3RpZmljYXRpb24gY29tZXMgdGhydSB0aGUgc2FtZSBldmVudCB0aGVuIGl0IGlzIGRpc3BhdGNoZXMgdG8gdGhlIHRhcmdldGVkIHN1YnNjcmlwdGlvbnMuXG4gICAgZnVuY3Rpb24gbGlzdGVuVG9TeW5jTm90aWZpY2F0aW9uKCkge1xuICAgICAgICAkc29ja2V0aW8ub24oJ1NZTkNfTk9XJywgZnVuY3Rpb24gKHN1Yk5vdGlmaWNhdGlvbiwgZm4pIHtcbiAgICAgICAgICAgIGNvbnNvbGUubG9nKCdTeW5jaW5nIHdpdGggc3Vic2NyaXB0aW9uIFtuYW1lOicgKyBzdWJOb3RpZmljYXRpb24ubmFtZSArICcsIGlkOicgKyBzdWJOb3RpZmljYXRpb24uc3Vic2NyaXB0aW9uSWQgKyAnICwgcGFyYW1zOicgKyBKU09OLnN0cmluZ2lmeShzdWJOb3RpZmljYXRpb24ucGFyYW1zKSArICddLiBSZWNvcmRzOicgKyBzdWJOb3RpZmljYXRpb24ucmVjb3Jkcy5sZW5ndGggKyAnWycgKyAoc3ViTm90aWZpY2F0aW9uLmRpZmYgPyAnRGlmZicgOiAnQWxsJykgKyAnXScpO1xuICAgICAgICAgICAgdmFyIGxpc3RlbmVycyA9IHB1YmxpY2F0aW9uTGlzdGVuZXJzW3N1Yk5vdGlmaWNhdGlvbi5uYW1lXTtcbiAgICAgICAgICAgIGlmIChsaXN0ZW5lcnMpIHtcbiAgICAgICAgICAgICAgICBmb3IgKHZhciBsaXN0ZW5lciBpbiBsaXN0ZW5lcnMpIHtcbiAgICAgICAgICAgICAgICAgICAgbGlzdGVuZXJzW2xpc3RlbmVyXShzdWJOb3RpZmljYXRpb24pO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGZuKCdTWU5DRUQnKTsgLy8gbGV0IGtub3cgdGhlIGJhY2tlbmQgdGhlIGNsaWVudCB3YXMgYWJsZSB0byBzeW5jLlxuICAgICAgICB9KTtcbiAgICB9O1xuXG5cbiAgICAvLyB0aGlzIGFsbG93cyBhIGRhdGFzZXQgdG8gbGlzdGVuIHRvIGFueSBTWU5DX05PVyBldmVudC4uYW5kIGlmIHRoZSBub3RpZmljYXRpb24gaXMgYWJvdXQgaXRzIGRhdGEuXG4gICAgZnVuY3Rpb24gYWRkUHVibGljYXRpb25MaXN0ZW5lcihzdHJlYW1OYW1lLCBjYWxsYmFjaykge1xuICAgICAgICB2YXIgdWlkID0gcHVibGljYXRpb25MaXN0ZW5lckNvdW50Kys7XG4gICAgICAgIHZhciBsaXN0ZW5lcnMgPSBwdWJsaWNhdGlvbkxpc3RlbmVyc1tzdHJlYW1OYW1lXTtcbiAgICAgICAgaWYgKCFsaXN0ZW5lcnMpIHtcbiAgICAgICAgICAgIHB1YmxpY2F0aW9uTGlzdGVuZXJzW3N0cmVhbU5hbWVdID0gbGlzdGVuZXJzID0ge307XG4gICAgICAgIH1cbiAgICAgICAgbGlzdGVuZXJzW3VpZF0gPSBjYWxsYmFjaztcblxuICAgICAgICByZXR1cm4gZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgZGVsZXRlIGxpc3RlbmVyc1t1aWRdO1xuICAgICAgICB9XG4gICAgfVxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgIC8vIFN1YnNjcmlwdGlvbiBvYmplY3RcbiAgICAvLyAtLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS1cbiAgICAvKipcbiAgICAgKiBhIHN1YnNjcmlwdGlvbiBzeW5jaHJvbml6ZXMgd2l0aCB0aGUgYmFja2VuZCBmb3IgYW55IGJhY2tlbmQgZGF0YSBjaGFuZ2UgYW5kIG1ha2VzIHRoYXQgZGF0YSBhdmFpbGFibGUgdG8gYSBjb250cm9sbGVyLlxuICAgICAqIFxuICAgICAqICBXaGVuIGNsaWVudCBzdWJzY3JpYmVzIHRvIGFuIHN5bmNyb25pemVkIGFwaSwgYW55IGRhdGEgY2hhbmdlIHRoYXQgaW1wYWN0cyB0aGUgYXBpIHJlc3VsdCBXSUxMIGJlIFBVU0hlZCB0byB0aGUgY2xpZW50LlxuICAgICAqIElmIHRoZSBjbGllbnQgZG9lcyBOT1Qgc3Vic2NyaWJlIG9yIHN0b3Agc3Vic2NyaWJlLCBpdCB3aWxsIG5vIGxvbmdlciByZWNlaXZlIHRoZSBQVVNILiBcbiAgICAgKiAgICBcbiAgICAgKiBpZiB0aGUgY29ubmVjdGlvbiBpcyBsb3N0IGZvciBhIHNob3J0IHRpbWUgKGR1cmF0aW9uIGRlZmluZWQgb24gc2VydmVyLXNpZGUpLCB0aGUgc2VydmVyIHF1ZXVlcyB0aGUgY2hhbmdlcyBpZiBhbnkuIFxuICAgICAqIFdoZW4gdGhlIGNvbm5lY3Rpb24gcmV0dXJucywgdGhlIG1pc3NpbmcgZGF0YSBhdXRvbWF0aWNhbGx5ICB3aWxsIGJlIFBVU0hlZCB0byB0aGUgc3Vic2NyaWJpbmcgY2xpZW50LlxuICAgICAqIGlmIHRoZSBjb25uZWN0aW9uIGlzIGxvc3QgZm9yIGEgbG9uZyB0aW1lIChkdXJhdGlvbiBkZWZpbmVkIG9uIHRoZSBzZXJ2ZXIpLCB0aGUgc2VydmVyIHdpbGwgZGVzdHJveSB0aGUgc3Vic2NyaXB0aW9uLiBUbyBzaW1wbGlmeSwgdGhlIGNsaWVudCB3aWxsIHJlc3Vic2NyaWJlIGF0IGl0cyByZWNvbm5lY3Rpb24gYW5kIGdldCBhbGwgZGF0YS5cbiAgICAgKiBcbiAgICAgKiBzdWJzY3JpcHRpb24gb2JqZWN0IHByb3ZpZGVzIDMgY2FsbGJhY2tzIChhZGQsdXBkYXRlLCBkZWwpIHdoaWNoIGFyZSBjYWxsZWQgZHVyaW5nIHN5bmNocm9uaXphdGlvbi5cbiAgICAgKiAgICAgIFxuICAgICAqIFNjb3BlIHdpbGwgYWxsb3cgdGhlIHN1YnNjcmlwdGlvbiBzdG9wIHN5bmNocm9uaXppbmcgYW5kIGNhbmNlbCByZWdpc3RyYXRpb24gd2hlbiBpdCBpcyBkZXN0cm95ZWQuIFxuICAgICAqICBcbiAgICAgKiBDb25zdHJ1Y3RvcjpcbiAgICAgKiBcbiAgICAgKiBAcGFyYW0gcHVibGljYXRpb24sIHRoZSBwdWJsaWNhdGlvbiBtdXN0IGV4aXN0IG9uIHRoZSBzZXJ2ZXIgc2lkZVxuICAgICAqIEBwYXJhbSBzY29wZSwgYnkgZGVmYXVsdCAkcm9vdFNjb3BlLCBidXQgY2FuIGJlIG1vZGlmaWVkIGxhdGVyIG9uIHdpdGggYXR0YWNoIG1ldGhvZC5cbiAgICAgKi9cblxuICAgIGZ1bmN0aW9uIFN1YnNjcmlwdGlvbihwdWJsaWNhdGlvbiwgc2NvcGUpIHtcbiAgICAgICAgdmFyIHN1YnNjcmlwdGlvbklkLCBtYXhSZXZpc2lvbiA9IDAsIHRpbWVzdGFtcEZpZWxkLCBpc1N5bmNpbmdPbiA9IGZhbHNlLCBpc1NpbmdsZSwgdXBkYXRlRGF0YVN0b3JhZ2UsIGNhY2hlLCBpc0luaXRpYWxQdXNoQ29tcGxldGVkLCBkZWZlcnJlZEluaXRpYWxpemF0aW9uO1xuICAgICAgICB2YXIgb25SZWFkeU9mZiwgZm9ybWF0UmVjb3JkO1xuICAgICAgICB2YXIgcmVjb25uZWN0T2ZmLCBwdWJsaWNhdGlvbkxpc3RlbmVyT2ZmLCBkZXN0cm95T2ZmO1xuICAgICAgICB2YXIgb2JqZWN0Q2xhc3M7XG5cbiAgICAgICAgdmFyIHNEcyA9IHRoaXM7XG4gICAgICAgIHZhciBzdWJQYXJhbXMgPSB7fTtcbiAgICAgICAgdmFyIHJlY29yZFN0YXRlcyA9IHt9O1xuICAgICAgICB2YXIgaW5uZXJTY29wZTsvLz0gJHJvb3RTY29wZS4kbmV3KHRydWUpO1xuICAgICAgICB2YXIgc3luY0xpc3RlbmVyID0gbmV3IFN5bmNMaXN0ZW5lcigpO1xuXG4gICAgICAgIHRoaXMucmVhZHkgPSBmYWxzZTtcbiAgICAgICAgdGhpcy5zeW5jT24gPSBzeW5jT247XG4gICAgICAgIHRoaXMuc3luY09mZiA9IHN5bmNPZmY7XG4gICAgICAgIHRoaXMuc2V0T25SZWFkeSA9IHNldE9uUmVhZHk7XG5cbiAgICAgICAgdGhpcy5vblJlYWR5ID0gb25SZWFkeTtcbiAgICAgICAgdGhpcy5vblVwZGF0ZSA9IG9uVXBkYXRlO1xuICAgICAgICB0aGlzLm9uQWRkID0gb25BZGQ7XG4gICAgICAgIHRoaXMub25SZW1vdmUgPSBvblJlbW92ZTtcblxuICAgICAgICB0aGlzLmdldERhdGEgPSBnZXREYXRhO1xuICAgICAgICB0aGlzLnNldFBhcmFtZXRlcnMgPSBzZXRQYXJhbWV0ZXJzO1xuXG4gICAgICAgIHRoaXMud2FpdEZvckRhdGFSZWFkeSA9IHdhaXRGb3JEYXRhUmVhZHk7XG4gICAgICAgIHRoaXMud2FpdEZvclN1YnNjcmlwdGlvblJlYWR5ID0gd2FpdEZvclN1YnNjcmlwdGlvblJlYWR5O1xuXG4gICAgICAgIHRoaXMuc2V0Rm9yY2UgPSBzZXRGb3JjZTtcbiAgICAgICAgdGhpcy5pc1N5bmNpbmcgPSBpc1N5bmNpbmc7XG4gICAgICAgIHRoaXMuaXNSZWFkeSA9IGlzUmVhZHk7XG5cbiAgICAgICAgdGhpcy5zZXRTaW5nbGUgPSBzZXRTaW5nbGU7XG5cbiAgICAgICAgdGhpcy5zZXRPYmplY3RDbGFzcyA9IHNldE9iamVjdENsYXNzO1xuICAgICAgICB0aGlzLmdldE9iamVjdENsYXNzID0gZ2V0T2JqZWN0Q2xhc3M7XG5cbiAgICAgICAgdGhpcy5hdHRhY2ggPSBhdHRhY2g7XG4gICAgICAgIHRoaXMuZGVzdHJveSA9IGRlc3Ryb3k7XG5cbiAgICAgICAgdGhpcy5pc0V4aXN0aW5nU3RhdGVGb3IgPSBpc0V4aXN0aW5nU3RhdGVGb3I7IC8vIGZvciB0ZXN0aW5nIHB1cnBvc2VzXG5cbiAgICAgICAgc2V0U2luZ2xlKGZhbHNlKTtcblxuICAgICAgICAvLyB0aGlzIHdpbGwgbWFrZSBzdXJlIHRoYXQgdGhlIHN1YnNjcmlwdGlvbiBpcyByZWxlYXNlZCBmcm9tIHNlcnZlcnMgaWYgdGhlIGFwcCBjbG9zZXMgKGNsb3NlIGJyb3dzZXIsIHJlZnJlc2guLi4pXG4gICAgICAgIGF0dGFjaChzY29wZSB8fCAkcm9vdFNjb3BlKTtcblxuICAgICAgICAvLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vXG5cbiAgICAgICAgZnVuY3Rpb24gZGVzdHJveSgpIHtcbiAgICAgICAgICAgIHN5bmNPZmYoKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8qKiB0aGlzIHdpbGwgYmUgY2FsbGVkIHdoZW4gZGF0YSBpcyBhdmFpbGFibGUgXG4gICAgICAgICAqICBpdCBtZWFucyByaWdodCBhZnRlciBlYWNoIHN5bmMhXG4gICAgICAgICAqIFxuICAgICAgICAgKiBcbiAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gc2V0T25SZWFkeShjYWxsYmFjaykge1xuICAgICAgICAgICAgaWYgKG9uUmVhZHlPZmYpIHtcbiAgICAgICAgICAgICAgICBvblJlYWR5T2ZmKCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBvblJlYWR5T2ZmID0gb25SZWFkeShjYWxsYmFjayk7XG4gICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICB9XG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqIGZvcmNlIHJlc3luY2luZyBmcm9tIHNjcmF0Y2ggZXZlbiBpZiB0aGUgcGFyYW1ldGVycyBoYXZlIG5vdCBjaGFuZ2VkXG4gICAgICAgICAqIFxuICAgICAgICAgKiBpZiBvdXRzaWRlIGNvZGUgaGFzIG1vZGlmaWVkIHRoZSBkYXRhIGFuZCB5b3UgbmVlZCB0byByb2xsYmFjaywgeW91IGNvdWxkIGNvbnNpZGVyIGZvcmNpbmcgYSByZWZyZXNoIHdpdGggdGhpcy4gQmV0dGVyIHNvbHV0aW9uIHNob3VsZCBiZSBmb3VuZCB0aGFuIHRoYXQuXG4gICAgICAgICAqIFxuICAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gc2V0Rm9yY2UodmFsdWUpIHtcbiAgICAgICAgICAgIGlmICh2YWx1ZSkge1xuICAgICAgICAgICAgICAgIC8vIHF1aWNrIGhhY2sgdG8gZm9yY2UgdG8gcmVsb2FkLi4ucmVjb2RlIGxhdGVyLlxuICAgICAgICAgICAgICAgIHNEcy5zeW5jT2ZmKCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICB9XG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqIFRoZSBmb2xsb3dpbmcgb2JqZWN0IHdpbGwgYmUgYnVpbHQgdXBvbiBlYWNoIHJlY29yZCByZWNlaXZlZCBmcm9tIHRoZSBiYWNrZW5kXG4gICAgICAgICAqIFxuICAgICAgICAgKiBUaGlzIGNhbm5vdCBiZSBtb2RpZmllZCBhZnRlciB0aGUgc3luYyBoYXMgc3RhcnRlZC5cbiAgICAgICAgICogXG4gICAgICAgICAqIEBwYXJhbSBjbGFzc1ZhbHVlXG4gICAgICAgICAqL1xuICAgICAgICBmdW5jdGlvbiBzZXRPYmplY3RDbGFzcyhjbGFzc1ZhbHVlKSB7XG4gICAgICAgICAgICBpZiAoZGVmZXJyZWRJbml0aWFsaXphdGlvbikge1xuICAgICAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIG9iamVjdENsYXNzID0gY2xhc3NWYWx1ZTtcbiAgICAgICAgICAgIGZvcm1hdFJlY29yZCA9IGZ1bmN0aW9uIChyZWNvcmQpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gbmV3IG9iamVjdENsYXNzKHJlY29yZCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBzZXRTaW5nbGUoaXNTaW5nbGUpO1xuICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIGdldE9iamVjdENsYXNzKCkge1xuICAgICAgICAgICAgcmV0dXJuIG9iamVjdENsYXNzO1xuICAgICAgICB9XG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqIHRoaXMgZnVuY3Rpb24gc3RhcnRzIHRoZSBzeW5jaW5nLlxuICAgICAgICAgKiBPbmx5IHB1YmxpY2F0aW9uIHB1c2hpbmcgZGF0YSBtYXRjaGluZyBvdXIgZmV0Y2hpbmcgcGFyYW1zIHdpbGwgYmUgcmVjZWl2ZWQuXG4gICAgICAgICAqIFxuICAgICAgICAgKiBleDogZm9yIGEgcHVibGljYXRpb24gbmFtZWQgXCJtYWdhemluZXMuc3luY1wiLCBpZiBmZXRjaGluZyBwYXJhbXMgZXF1YWxsZWQge21hZ2F6aW5OYW1lOidjYXJzJ30sIHRoZSBtYWdhemluZSBjYXJzIGRhdGEgd291bGQgYmUgcmVjZWl2ZWQgYnkgdGhpcyBzdWJzY3JpcHRpb24uXG4gICAgICAgICAqIFxuICAgICAgICAgKiBAcGFyYW0gZmV0Y2hpbmdQYXJhbXNcbiAgICAgICAgICogQHBhcmFtIG9wdGlvbnNcbiAgICAgICAgICogXG4gICAgICAgICAqIEByZXR1cm5zIGEgcHJvbWlzZSB0aGF0IHJlc29sdmVzIHdoZW4gZGF0YSBpcyBhcnJpdmVkLlxuICAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gc2V0UGFyYW1ldGVycyhmZXRjaGluZ1BhcmFtcywgb3B0aW9ucykge1xuICAgICAgICAgICAgaWYgKGlzU3luY2luZ09uICYmIGFuZ3VsYXIuZXF1YWxzKGZldGNoaW5nUGFyYW1zLCBzdWJQYXJhbXMpKSB7XG4gICAgICAgICAgICAgICAgLy8gaWYgdGhlIHBhcmFtcyBoYXZlIG5vdCBjaGFuZ2VkLCBqdXN0IHJldHVybnMgd2l0aCBjdXJyZW50IGRhdGEuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHNEczsgLy8kcS5yZXNvbHZlKGdldERhdGEoKSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBzeW5jT2ZmKCk7XG4gICAgICAgICAgICBpZiAoIWlzU2luZ2xlKSB7XG4gICAgICAgICAgICAgICAgY2FjaGUubGVuZ3RoID0gMDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIG1heFJldmlzaW9uID0gMDtcbiAgICAgICAgICAgIHN1YlBhcmFtcyA9IGZldGNoaW5nUGFyYW1zIHx8IHt9O1xuICAgICAgICAgICAgb3B0aW9ucyA9IG9wdGlvbnMgfHwge307XG4gICAgICAgICAgICBpZiAoYW5ndWxhci5pc0RlZmluZWQob3B0aW9ucy5zaW5nbGUpKSB7XG4gICAgICAgICAgICAgICAgc2V0U2luZ2xlKG9wdGlvbnMuc2luZ2xlKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHN5bmNPbigpO1xuICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIHdhaXQgZm9yIHRoZSBpbml0aWFsIGZldGNoIHRvIGNvbXBsZXRlIHRoZW4gcmV0dXJucyB0aGlzIHN1YnNjcmlwdGlvblxuICAgICAgICBmdW5jdGlvbiB3YWl0Rm9yU3Vic2NyaXB0aW9uUmVhZHkoKSB7XG4gICAgICAgICAgICByZXR1cm4gZGVmZXJyZWRJbml0aWFsaXphdGlvbi5wcm9taXNlLnRoZW4oZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIHdhaXQgZm9yIHRoZSBpbml0aWFsIGZldGNoIHRvIGNvbXBsZXRlIHRoZW4gcmV0dXJucyB0aGUgZGF0YVxuICAgICAgICBmdW5jdGlvbiB3YWl0Rm9yRGF0YVJlYWR5KCkge1xuICAgICAgICAgICAgcmV0dXJuIGRlZmVycmVkSW5pdGlhbGl6YXRpb24ucHJvbWlzZTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIGRvZXMgdGhlIGRhdGFzZXQgcmV0dXJucyBvbmx5IG9uZSBvYmplY3Q/IG5vdCBhbiBhcnJheT9cbiAgICAgICAgZnVuY3Rpb24gc2V0U2luZ2xlKHZhbHVlKSB7XG4gICAgICAgICAgICBpZiAoZGVmZXJyZWRJbml0aWFsaXphdGlvbikge1xuICAgICAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlzU2luZ2xlID0gdmFsdWU7XG4gICAgICAgICAgICBpZiAodmFsdWUpIHtcbiAgICAgICAgICAgICAgICB1cGRhdGVEYXRhU3RvcmFnZSA9IHVwZGF0ZVN5bmNlZE9iamVjdDtcbiAgICAgICAgICAgICAgICBjYWNoZSA9IG9iamVjdENsYXNzID8gbmV3IG9iamVjdENsYXNzKHt9KSA6IHt9O1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB1cGRhdGVEYXRhU3RvcmFnZSA9IHVwZGF0ZVN5bmNlZEFycmF5O1xuICAgICAgICAgICAgICAgIGNhY2hlID0gW107XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gcmV0dXJucyB0aGUgb2JqZWN0IG9yIGFycmF5IGluIHN5bmNcbiAgICAgICAgZnVuY3Rpb24gZ2V0RGF0YSgpIHtcbiAgICAgICAgICAgIHJldHVybiBjYWNoZTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiB0aGUgZGF0YXNldCB3aWxsIHN0YXJ0IGxpc3RlbmluZyB0byB0aGUgZGF0YXN0cmVhbSBcbiAgICAgICAgICogXG4gICAgICAgICAqIE5vdGUgRHVyaW5nIHRoZSBzeW5jLCBpdCB3aWxsIGFsc28gY2FsbCB0aGUgb3B0aW9uYWwgY2FsbGJhY2tzIC0gYWZ0ZXIgcHJvY2Vzc2luZyBFQUNIIHJlY29yZCByZWNlaXZlZC5cbiAgICAgICAgICogXG4gICAgICAgICAqIEByZXR1cm5zIGEgcHJvbWlzZSB0aGF0IHdpbGwgYmUgcmVzb2x2ZWQgd2hlbiB0aGUgZGF0YSBpcyByZWFkeS5cbiAgICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIHN5bmNPbigpIHtcbiAgICAgICAgICAgIGlmIChpc1N5bmNpbmdPbikge1xuICAgICAgICAgICAgICAgIHJldHVybiBkZWZlcnJlZEluaXRpYWxpemF0aW9uLnByb21pc2U7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBkZWZlcnJlZEluaXRpYWxpemF0aW9uID0gJHEuZGVmZXIoKTtcbiAgICAgICAgICAgIGlzSW5pdGlhbFB1c2hDb21wbGV0ZWQgPSBmYWxzZTtcbiAgICAgICAgICAgIGNvbnNvbGUubG9nKCdTeW5jICcgKyBwdWJsaWNhdGlvbiArICcgb24uIFBhcmFtczonICsgSlNPTi5zdHJpbmdpZnkoc3ViUGFyYW1zKSk7XG4gICAgICAgICAgICBpc1N5bmNpbmdPbiA9IHRydWU7XG4gICAgICAgICAgICByZWdpc3RlclN1YnNjcmlwdGlvbigpO1xuICAgICAgICAgICAgcmVhZHlGb3JMaXN0ZW5pbmcoKTtcbiAgICAgICAgICAgIHJldHVybiBkZWZlcnJlZEluaXRpYWxpemF0aW9uLnByb21pc2U7XG4gICAgICAgIH1cblxuICAgICAgICAvKipcbiAgICAgICAgICogdGhlIGRhdGFzZXQgaXMgbm8gbG9uZ2VyIGxpc3RlbmluZyBhbmQgd2lsbCBub3QgY2FsbCBhbnkgY2FsbGJhY2tcbiAgICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIHN5bmNPZmYoKSB7XG4gICAgICAgICAgICBpZiAoZGVmZXJyZWRJbml0aWFsaXphdGlvbikge1xuICAgICAgICAgICAgICAgIC8vIGlmIHRoZXJlIGlzIGNvZGUgd2FpdGluZyBvbiB0aGlzIHByb21pc2UuLiBleCAobG9hZCBpbiByZXNvbHZlKVxuICAgICAgICAgICAgICAgIGRlZmVycmVkSW5pdGlhbGl6YXRpb24ucmVzb2x2ZShnZXREYXRhKCkpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKGlzU3luY2luZ09uKSB7XG4gICAgICAgICAgICAgICAgdW5yZWdpc3RlclN1YnNjcmlwdGlvbigpO1xuICAgICAgICAgICAgICAgIGlzU3luY2luZ09uID0gZmFsc2U7XG5cbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZygnU3luYyAnICsgcHVibGljYXRpb24gKyAnIG9mZi4gUGFyYW1zOicgKyBKU09OLnN0cmluZ2lmeShzdWJQYXJhbXMpKTtcbiAgICAgICAgICAgICAgICBpZiAocHVibGljYXRpb25MaXN0ZW5lck9mZikge1xuICAgICAgICAgICAgICAgICAgICBwdWJsaWNhdGlvbkxpc3RlbmVyT2ZmKCk7XG4gICAgICAgICAgICAgICAgICAgIHB1YmxpY2F0aW9uTGlzdGVuZXJPZmYgPSBudWxsO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBpZiAocmVjb25uZWN0T2ZmKSB7XG4gICAgICAgICAgICAgICAgICAgIHJlY29ubmVjdE9mZigpO1xuICAgICAgICAgICAgICAgICAgICByZWNvbm5lY3RPZmYgPSBudWxsO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIGlzU3luY2luZygpIHtcbiAgICAgICAgICAgIHJldHVybiBpc1N5bmNpbmdPbjtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIHJlYWR5Rm9yTGlzdGVuaW5nKCkge1xuICAgICAgICAgICAgaWYgKCFwdWJsaWNhdGlvbkxpc3RlbmVyT2ZmKSB7XG4gICAgICAgICAgICAgICAgbGlzdGVuRm9yUmVjb25uZWN0aW9uVG9SZXN5bmMoKTtcbiAgICAgICAgICAgICAgICBsaXN0ZW5Ub1B1YmxpY2F0aW9uKCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICAvKipcbiAgICAgICAgICogIEJ5IGRlZmF1bHQgdGhlIHJvb3RzY29wZSBpcyBhdHRhY2hlZCBpZiBubyBzY29wZSB3YXMgcHJvdmlkZWQuIEJ1dCBpdCBpcyBwb3NzaWJsZSB0byByZS1hdHRhY2ggaXQgdG8gYSBkaWZmZXJlbnQgc2NvcGUuIGlmIHRoZSBzdWJzY3JpcHRpb24gZGVwZW5kcyBvbiBhIGNvbnRyb2xsZXIuXG4gICAgICAgICAqXG4gICAgICAgICAqICBEbyBub3QgYXR0YWNoIGFmdGVyIGl0IGhhcyBzeW5jZWQuXG4gICAgICAgICAqL1xuICAgICAgICBmdW5jdGlvbiBhdHRhY2gobmV3U2NvcGUpIHtcbiAgICAgICAgICAgIGlmIChkZWZlcnJlZEluaXRpYWxpemF0aW9uKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChkZXN0cm95T2ZmKSB7XG4gICAgICAgICAgICAgICAgZGVzdHJveU9mZigpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaW5uZXJTY29wZSA9IG5ld1Njb3BlO1xuICAgICAgICAgICAgZGVzdHJveU9mZiA9IGlubmVyU2NvcGUuJG9uKCckZGVzdHJveScsIGRlc3Ryb3kpO1xuXG4gICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gbGlzdGVuRm9yUmVjb25uZWN0aW9uVG9SZXN5bmMobGlzdGVuTm93KSB7XG4gICAgICAgICAgICAvLyBnaXZlIGEgY2hhbmNlIHRvIGNvbm5lY3QgYmVmb3JlIGxpc3RlbmluZyB0byByZWNvbm5lY3Rpb24uLi4gQFRPRE8gc2hvdWxkIGhhdmUgdXNlcl9yZWNvbm5lY3RlZF9ldmVudFxuICAgICAgICAgICAgc2V0VGltZW91dChmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgcmVjb25uZWN0T2ZmID0gaW5uZXJTY29wZS4kb24oJ3VzZXJfY29ubmVjdGVkJywgZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgICAgICBjb25zb2xlLmRlYnVnKCdSZXN5bmNpbmcgYWZ0ZXIgbmV0d29yayBsb3NzIHRvICcgKyBwdWJsaWNhdGlvbik7XG4gICAgICAgICAgICAgICAgICAgIC8vIG5vdGUgdGhlIGJhY2tlbmQgbWlnaHQgcmV0dXJuIGEgbmV3IHN1YnNjcmlwdGlvbiBpZiB0aGUgY2xpZW50IHRvb2sgdG9vIG11Y2ggdGltZSB0byByZWNvbm5lY3QuXG4gICAgICAgICAgICAgICAgICAgIHJlZ2lzdGVyU3Vic2NyaXB0aW9uKCk7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9LCBsaXN0ZW5Ob3cgPyAwIDogMjAwMCk7XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiByZWdpc3RlclN1YnNjcmlwdGlvbigpIHtcbiAgICAgICAgICAgICRzb2NrZXRpby5mZXRjaCgnc3luYy5zdWJzY3JpYmUnLCB7XG4gICAgICAgICAgICAgICAgdmVyc2lvbjogU1lOQ19WRVJTSU9OLFxuICAgICAgICAgICAgICAgIGlkOiBzdWJzY3JpcHRpb25JZCwgLy8gdG8gdHJ5IHRvIHJlLXVzZSBleGlzdGluZyBzdWJjcmlwdGlvblxuICAgICAgICAgICAgICAgIHB1YmxpY2F0aW9uOiBwdWJsaWNhdGlvbixcbiAgICAgICAgICAgICAgICBwYXJhbXM6IHN1YlBhcmFtc1xuICAgICAgICAgICAgfSkudGhlbihmdW5jdGlvbiAoc3ViSWQpIHtcbiAgICAgICAgICAgICAgICBzdWJzY3JpcHRpb25JZCA9IHN1YklkO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiB1bnJlZ2lzdGVyU3Vic2NyaXB0aW9uKCkge1xuICAgICAgICAgICAgaWYgKHN1YnNjcmlwdGlvbklkKSB7XG4gICAgICAgICAgICAgICAgJHNvY2tldGlvLmZldGNoKCdzeW5jLnVuc3Vic2NyaWJlJywge1xuICAgICAgICAgICAgICAgICAgICB2ZXJzaW9uOiBTWU5DX1ZFUlNJT04sXG4gICAgICAgICAgICAgICAgICAgIGlkOiBzdWJzY3JpcHRpb25JZFxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIHN1YnNjcmlwdGlvbklkID0gbnVsbDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIGxpc3RlblRvUHVibGljYXRpb24oKSB7XG4gICAgICAgICAgICAvLyBjYW5ub3Qgb25seSBsaXN0ZW4gdG8gc3Vic2NyaXB0aW9uSWQgeWV0Li4uYmVjYXVzZSB0aGUgcmVnaXN0cmF0aW9uIG1pZ2h0IGhhdmUgYW5zd2VyIHByb3ZpZGVkIGl0cyBpZCB5ZXQuLi5idXQgc3RhcnRlZCBicm9hZGNhc3RpbmcgY2hhbmdlcy4uLkBUT0RPIGNhbiBiZSBpbXByb3ZlZC4uLlxuICAgICAgICAgICAgcHVibGljYXRpb25MaXN0ZW5lck9mZiA9IGFkZFB1YmxpY2F0aW9uTGlzdGVuZXIocHVibGljYXRpb24sIGZ1bmN0aW9uIChiYXRjaCkge1xuICAgICAgICAgICAgICAgIGlmIChzdWJzY3JpcHRpb25JZCA9PT0gYmF0Y2guc3Vic2NyaXB0aW9uSWQgfHwgKCFzdWJzY3JpcHRpb25JZCAmJiBjaGVja0RhdGFTZXRQYXJhbXNJZk1hdGNoaW5nQmF0Y2hQYXJhbXMoYmF0Y2gucGFyYW1zKSkpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFiYXRjaC5kaWZmKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBDbGVhciB0aGUgY2FjaGUgdG8gcmVidWlsZCBpdCBpZiBhbGwgZGF0YSB3YXMgcmVjZWl2ZWQuXG4gICAgICAgICAgICAgICAgICAgICAgICByZWNvcmRTdGF0ZXMgPSB7fTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghaXNTaW5nbGUpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYWNoZS5sZW5ndGggPSAwO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIGFwcGx5Q2hhbmdlcyhiYXRjaC5yZWNvcmRzKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFpc0luaXRpYWxQdXNoQ29tcGxldGVkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpc0luaXRpYWxQdXNoQ29tcGxldGVkID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGRlZmVycmVkSW5pdGlhbGl6YXRpb24ucmVzb2x2ZShnZXREYXRhKCkpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICAvKipcbiAgICAgICAgKiBpZiB0aGUgcGFyYW1zIG9mIHRoZSBkYXRhc2V0IG1hdGNoZXMgdGhlIG5vdGlmaWNhdGlvbiwgaXQgbWVhbnMgdGhlIGRhdGEgbmVlZHMgdG8gYmUgY29sbGVjdCB0byB1cGRhdGUgYXJyYXkuXG4gICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIGNoZWNrRGF0YVNldFBhcmFtc0lmTWF0Y2hpbmdCYXRjaFBhcmFtcyhiYXRjaFBhcmFtcykge1xuICAgICAgICAgICAgLy8gaWYgKHBhcmFtcy5sZW5ndGggIT0gc3RyZWFtUGFyYW1zLmxlbmd0aCkge1xuICAgICAgICAgICAgLy8gICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIC8vIH1cbiAgICAgICAgICAgIGlmICghc3ViUGFyYW1zIHx8IE9iamVjdC5rZXlzKHN1YlBhcmFtcykubGVuZ3RoID09IDApIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdmFyIG1hdGNoaW5nID0gdHJ1ZTtcbiAgICAgICAgICAgIGZvciAodmFyIHBhcmFtIGluIGJhdGNoUGFyYW1zKSB7XG4gICAgICAgICAgICAgICAgLy8gYXJlIG90aGVyIHBhcmFtcyBtYXRjaGluZz9cbiAgICAgICAgICAgICAgICAvLyBleDogd2UgbWlnaHQgaGF2ZSByZWNlaXZlIGEgbm90aWZpY2F0aW9uIGFib3V0IHRhc2tJZD0yMCBidXQgdGhpcyBzdWJzY3JpcHRpb24gYXJlIG9ubHkgaW50ZXJlc3RlZCBhYm91dCB0YXNrSWQtM1xuICAgICAgICAgICAgICAgIGlmIChiYXRjaFBhcmFtc1twYXJhbV0gIT09IHN1YlBhcmFtc1twYXJhbV0pIHtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIG1hdGNoaW5nO1xuXG4gICAgICAgIH1cblxuICAgICAgICAvLyBmZXRjaCBhbGwgdGhlIG1pc3NpbmcgcmVjb3JkcywgYW5kIGFjdGl2YXRlIHRoZSBjYWxsIGJhY2tzIChhZGQsdXBkYXRlLHJlbW92ZSkgYWNjb3JkaW5nbHkgaWYgdGhlcmUgaXMgc29tZXRoaW5nIHRoYXQgaXMgbmV3IG9yIG5vdCBhbHJlYWR5IGluIHN5bmMuXG4gICAgICAgIGZ1bmN0aW9uIGFwcGx5Q2hhbmdlcyhyZWNvcmRzKSB7XG4gICAgICAgICAgICB2YXIgbmV3RGF0YUFycmF5ID0gW107XG4gICAgICAgICAgICB2YXIgbmV3RGF0YTtcbiAgICAgICAgICAgIHNEcy5yZWFkeSA9IGZhbHNlO1xuICAgICAgICAgICAgcmVjb3Jkcy5mb3JFYWNoKGZ1bmN0aW9uIChyZWNvcmQpIHtcbiAgICAgICAgICAgICAgICAvLyAgICAgICAgICAgICAgICAgICBjb25zb2xlLmxvZygnRGF0YXN5bmMgWycgKyBkYXRhU3RyZWFtTmFtZSArICddIHJlY2VpdmVkOicgK0pTT04uc3RyaW5naWZ5KHJlY29yZCkpOy8vKyByZWNvcmQuaWQpO1xuICAgICAgICAgICAgICAgIGlmIChyZWNvcmQucmVtb3ZlKSB7XG4gICAgICAgICAgICAgICAgICAgIHJlbW92ZVJlY29yZChyZWNvcmQpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAocmVjb3JkU3RhdGVzW3JlY29yZC5pZF0pIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gaWYgdGhlIHJlY29yZCBpcyBhbHJlYWR5IHByZXNlbnQgaW4gdGhlIGNhY2hlLi4uc28gaXQgaXMgbWlnaHRiZSBhbiB1cGRhdGUuLlxuICAgICAgICAgICAgICAgICAgICBuZXdEYXRhID0gdXBkYXRlUmVjb3JkKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgbmV3RGF0YSA9IGFkZFJlY29yZChyZWNvcmQpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBpZiAobmV3RGF0YSkge1xuICAgICAgICAgICAgICAgICAgICBuZXdEYXRhQXJyYXkucHVzaChuZXdEYXRhKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIHNEcy5yZWFkeSA9IHRydWU7XG4gICAgICAgICAgICBpZiAoaXNTaW5nbGUpIHtcbiAgICAgICAgICAgICAgICBzeW5jTGlzdGVuZXIubm90aWZ5KCdyZWFkeScsIGdldERhdGEoKSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHN5bmNMaXN0ZW5lci5ub3RpZnkoJ3JlYWR5JywgZ2V0RGF0YSgpLCBuZXdEYXRhQXJyYXkpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqIEFsdGhvdWdoIG1vc3QgY2FzZXMgYXJlIGhhbmRsZWQgdXNpbmcgb25SZWFkeSwgdGhpcyB0ZWxscyB5b3UgdGhlIGN1cnJlbnQgZGF0YSBzdGF0ZS5cbiAgICAgICAgICogXG4gICAgICAgICAqIEByZXR1cm5zIGlmIHRydWUgaXMgYSBzeW5jIGhhcyBiZWVuIHByb2Nlc3NlZCBvdGhlcndpc2UgZmFsc2UgaWYgdGhlIGRhdGEgaXMgbm90IHJlYWR5LlxuICAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gaXNSZWFkeSgpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLnJlYWR5O1xuICAgICAgICB9XG4gICAgICAgIC8qKlxuICAgICAgICAgKiBcbiAgICAgICAgICogcmV0dXJucyBhIGZ1bmN0aW9uIHRvIHJlbW92ZSB0aGUgbGlzdGVuZXIuXG4gICAgICAgICAqL1xuICAgICAgICBmdW5jdGlvbiBvbkFkZChjYWxsYmFjaykge1xuICAgICAgICAgICAgcmV0dXJuIHN5bmNMaXN0ZW5lci5vbignYWRkJywgY2FsbGJhY2spO1xuICAgICAgICB9XG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqIFxuICAgICAgICAgKiByZXR1cm5zIGEgZnVuY3Rpb24gdG8gcmVtb3ZlIHRoZSBsaXN0ZW5lci5cbiAgICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIG9uVXBkYXRlKGNhbGxiYWNrKSB7XG4gICAgICAgICAgICByZXR1cm4gc3luY0xpc3RlbmVyLm9uKCd1cGRhdGUnLCBjYWxsYmFjayk7XG4gICAgICAgIH1cblxuICAgICAgICAvKipcbiAgICAgICAgICogXG4gICAgICAgICAqIHJldHVybnMgYSBmdW5jdGlvbiB0byByZW1vdmUgdGhlIGxpc3RlbmVyLlxuICAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gb25SZW1vdmUoY2FsbGJhY2spIHtcbiAgICAgICAgICAgIHJldHVybiBzeW5jTGlzdGVuZXIub24oJ3JlbW92ZScsIGNhbGxiYWNrKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiBcbiAgICAgICAgICogcmV0dXJucyBhIGZ1bmN0aW9uIHRvIHJlbW92ZSB0aGUgbGlzdGVuZXIuXG4gICAgICAgICAqL1xuICAgICAgICBmdW5jdGlvbiBvblJlYWR5KGNhbGxiYWNrKSB7XG4gICAgICAgICAgICByZXR1cm4gc3luY0xpc3RlbmVyLm9uKCdyZWFkeScsIGNhbGxiYWNrKTtcbiAgICAgICAgfVxuXG5cbiAgICAgICAgZnVuY3Rpb24gYWRkUmVjb3JkKHJlY29yZCkge1xuICAgICAgICAgICAgY29uc29sZS5kZWJ1ZygnU3luYyAtPiBJbnNlcnRlZCBOZXcgcmVjb3JkICMnICsgcmVjb3JkLmlkICsgJyBmb3Igc3Vic2NyaXB0aW9uIHRvICcgKyBwdWJsaWNhdGlvbik7Ly8gSlNPTi5zdHJpbmdpZnkocmVjb3JkKSk7XG4gICAgICAgICAgICBnZXRSZXZpc2lvbihyZWNvcmQpOyAvLyBqdXN0IG1ha2Ugc3VyZSB3ZSBjYW4gZ2V0IGEgcmV2aXNpb24gYmVmb3JlIHdlIGhhbmRsZSB0aGlzIHJlY29yZFxuICAgICAgICAgICAgdXBkYXRlRGF0YVN0b3JhZ2UoZm9ybWF0UmVjb3JkID8gZm9ybWF0UmVjb3JkKHJlY29yZCkgOiByZWNvcmQpO1xuICAgICAgICAgICAgc3luY0xpc3RlbmVyLm5vdGlmeSgnYWRkJywgcmVjb3JkKTtcbiAgICAgICAgICAgIHJldHVybiByZWNvcmQ7XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiB1cGRhdGVSZWNvcmQocmVjb3JkKSB7XG4gICAgICAgICAgICB2YXIgcHJldmlvdXMgPSByZWNvcmRTdGF0ZXNbcmVjb3JkLmlkXTtcbiAgICAgICAgICAgIGlmIChnZXRSZXZpc2lvbihyZWNvcmQpIDw9IGdldFJldmlzaW9uKHByZXZpb3VzKSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBudWxsO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc29sZS5kZWJ1ZygnU3luYyAtPiBVcGRhdGVkIHJlY29yZCAjJyArIHJlY29yZC5pZCArICcgZm9yIHN1YnNjcmlwdGlvbiB0byAnICsgcHVibGljYXRpb24pOy8vIEpTT04uc3RyaW5naWZ5KHJlY29yZCkpO1xuICAgICAgICAgICAgdXBkYXRlRGF0YVN0b3JhZ2UoZm9ybWF0UmVjb3JkID8gZm9ybWF0UmVjb3JkKHJlY29yZCkgOiByZWNvcmQpO1xuICAgICAgICAgICAgc3luY0xpc3RlbmVyLm5vdGlmeSgndXBkYXRlJywgcmVjb3JkKTtcbiAgICAgICAgICAgIHJldHVybiByZWNvcmQ7XG4gICAgICAgIH1cblxuXG4gICAgICAgIGZ1bmN0aW9uIHJlbW92ZVJlY29yZChyZWNvcmQpIHtcbiAgICAgICAgICAgIHZhciBwcmV2aW91cyA9IHJlY29yZFN0YXRlc1tyZWNvcmQuaWRdO1xuICAgICAgICAgICAgaWYgKCFwcmV2aW91cyB8fCBnZXRSZXZpc2lvbihyZWNvcmQpID4gZ2V0UmV2aXNpb24ocHJldmlvdXMpKSB7XG4gICAgICAgICAgICAgICAgY29uc29sZS5kZWJ1ZygnU3luYyAtPiBSZW1vdmVkICMnICsgcmVjb3JkLmlkICsgJyBmb3Igc3Vic2NyaXB0aW9uIHRvICcgKyBwdWJsaWNhdGlvbik7XG4gICAgICAgICAgICAgICAgLy8gV2UgY291bGQgaGF2ZSBmb3IgdGhlIHNhbWUgcmVjb3JkIGNvbnNlY3V0aXZlbHkgZmV0Y2hpbmcgaW4gdGhpcyBvcmRlcjpcbiAgICAgICAgICAgICAgICAvLyBkZWxldGUgaWQ6NCwgcmV2IDEwLCB0aGVuIGFkZCBpZDo0LCByZXYgOS4uLi4gYnkga2VlcGluZyB0cmFjayBvZiB3aGF0IHdhcyBkZWxldGVkLCB3ZSB3aWxsIG5vdCBhZGQgdGhlIHJlY29yZCBzaW5jZSBpdCB3YXMgZGVsZXRlZCB3aXRoIGEgbW9zdCByZWNlbnQgdGltZXN0YW1wLlxuICAgICAgICAgICAgICAgIHJlY29yZC5yZW1vdmVkID0gdHJ1ZTsgLy8gU28gd2Ugb25seSBmbGFnIGFzIHJlbW92ZWQsIGxhdGVyIG9uIHRoZSBnYXJiYWdlIGNvbGxlY3RvciB3aWxsIGdldCByaWQgb2YgaXQuICAgICAgICAgXG4gICAgICAgICAgICAgICAgdXBkYXRlRGF0YVN0b3JhZ2UocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAvLyBpZiB0aGVyZSBpcyBubyBwcmV2aW91cyByZWNvcmQgd2UgZG8gbm90IG5lZWQgdG8gcmVtb3ZlZCBhbnkgdGhpbmcgZnJvbSBvdXIgc3RvcmFnZS4gICAgIFxuICAgICAgICAgICAgICAgIGlmIChwcmV2aW91cykge1xuICAgICAgICAgICAgICAgICAgICBzeW5jTGlzdGVuZXIubm90aWZ5KCdyZW1vdmUnLCByZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICBkaXNwb3NlKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGZ1bmN0aW9uIGRpc3Bvc2UocmVjb3JkKSB7XG4gICAgICAgICAgICAkc3luY0dhcmJhZ2VDb2xsZWN0b3IuZGlzcG9zZShmdW5jdGlvbiBjb2xsZWN0KCkge1xuICAgICAgICAgICAgICAgIHZhciBleGlzdGluZ1JlY29yZCA9IHJlY29yZFN0YXRlc1tyZWNvcmQuaWRdO1xuICAgICAgICAgICAgICAgIGlmIChleGlzdGluZ1JlY29yZCAmJiByZWNvcmQucmV2aXNpb24gPj0gZXhpc3RpbmdSZWNvcmQucmV2aXNpb25cbiAgICAgICAgICAgICAgICApIHtcbiAgICAgICAgICAgICAgICAgICAgLy9jb25zb2xlLmRlYnVnKCdDb2xsZWN0IE5vdzonICsgSlNPTi5zdHJpbmdpZnkocmVjb3JkKSk7XG4gICAgICAgICAgICAgICAgICAgIGRlbGV0ZSByZWNvcmRTdGF0ZXNbcmVjb3JkLmlkXTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIGlzRXhpc3RpbmdTdGF0ZUZvcihyZWNvcmRJZCkge1xuICAgICAgICAgICAgcmV0dXJuICEhcmVjb3JkU3RhdGVzW3JlY29yZElkXTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIHVwZGF0ZVN5bmNlZE9iamVjdChyZWNvcmQpIHtcbiAgICAgICAgICAgIHJlY29yZFN0YXRlc1tyZWNvcmQuaWRdID0gcmVjb3JkO1xuICAgICAgICAgICAgY2xlYXJPYmplY3QoY2FjaGUpO1xuICAgICAgICAgICAgaWYgKCFyZWNvcmQucmVtb3ZlKSB7XG4gICAgICAgICAgICAgICAgYW5ndWxhci5leHRlbmQoY2FjaGUsIHJlY29yZCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiB1cGRhdGVTeW5jZWRBcnJheShyZWNvcmQpIHtcbiAgICAgICAgICAgIHZhciBleGlzdGluZyA9IHJlY29yZFN0YXRlc1tyZWNvcmQuaWRdO1xuICAgICAgICAgICAgaWYgKCFleGlzdGluZykge1xuICAgICAgICAgICAgICAgIC8vIGFkZCBuZXcgaW5zdGFuY2VcbiAgICAgICAgICAgICAgICByZWNvcmRTdGF0ZXNbcmVjb3JkLmlkXSA9IHJlY29yZDtcbiAgICAgICAgICAgICAgICBpZiAoIXJlY29yZC5yZW1vdmVkKSB7XG4gICAgICAgICAgICAgICAgICAgIGNhY2hlLnB1c2gocmVjb3JkKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIC8vIHVwZGF0ZSB0aGUgaW5zdGFuY2VcbiAgICAgICAgICAgICAgICBjbGVhck9iamVjdChleGlzdGluZyk7XG4gICAgICAgICAgICAgICAgYW5ndWxhci5leHRlbmQoZXhpc3RpbmcsIHJlY29yZCk7XG4gICAgICAgICAgICAgICAgaWYgKHJlY29yZC5yZW1vdmVkKSB7XG4gICAgICAgICAgICAgICAgICAgIGNhY2hlLnNwbGljZShjYWNoZS5pbmRleE9mKGV4aXN0aW5nKSwgMSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gY2xlYXJPYmplY3Qob2JqZWN0KSB7XG4gICAgICAgICAgICBPYmplY3Qua2V5cyhvYmplY3QpLmZvckVhY2goZnVuY3Rpb24gKGtleSkgeyBkZWxldGUgb2JqZWN0W2tleV07IH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gZ2V0UmV2aXNpb24ocmVjb3JkKSB7XG4gICAgICAgICAgICAvLyB3aGF0IHJlc2VydmVkIGZpZWxkIGRvIHdlIHVzZSBhcyB0aW1lc3RhbXBcbiAgICAgICAgICAgIGlmIChhbmd1bGFyLmlzRGVmaW5lZChyZWNvcmQucmV2aXNpb24pKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlY29yZC5yZXZpc2lvbjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChhbmd1bGFyLmlzRGVmaW5lZChyZWNvcmQudGltZXN0YW1wKSkge1xuICAgICAgICAgICAgICAgIHJldHVybiByZWNvcmQudGltZXN0YW1wO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdTeW5jIHJlcXVpcmVzIGEgcmV2aXNpb24gb3IgdGltZXN0YW1wIHByb3BlcnR5IGluIHJlY2VpdmVkICcgKyAob2JqZWN0Q2xhc3MgPyAnb2JqZWN0IFsnICsgb2JqZWN0Q2xhc3MubmFtZSArICddJyA6ICdyZWNvcmQnKSk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiB0aGlzIG9iamVjdCBcbiAgICAgKi9cbiAgICBmdW5jdGlvbiBTeW5jTGlzdGVuZXIoKSB7XG4gICAgICAgIHZhciBldmVudHMgPSB7fTtcbiAgICAgICAgdmFyIGNvdW50ID0gMDtcblxuICAgICAgICB0aGlzLm5vdGlmeSA9IG5vdGlmeTtcbiAgICAgICAgdGhpcy5vbiA9IG9uO1xuXG4gICAgICAgIGZ1bmN0aW9uIG5vdGlmeShldmVudCwgZGF0YTEsIGRhdGEyKSB7XG4gICAgICAgICAgICB2YXIgbGlzdGVuZXJzID0gZXZlbnRzW2V2ZW50XTtcbiAgICAgICAgICAgIGlmIChsaXN0ZW5lcnMpIHtcbiAgICAgICAgICAgICAgICBfLmZvckVhY2gobGlzdGVuZXJzLCBmdW5jdGlvbiAoY2FsbGJhY2ssIGlkKSB7XG4gICAgICAgICAgICAgICAgICAgIGNhbGxiYWNrKGRhdGExLCBkYXRhMik7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICAvKipcbiAgICAgICAgICogQHJldHVybnMgaGFuZGxlciB0byB1bnJlZ2lzdGVyIGxpc3RlbmVyXG4gICAgICAgICAqL1xuICAgICAgICBmdW5jdGlvbiBvbihldmVudCwgY2FsbGJhY2spIHtcbiAgICAgICAgICAgIHZhciBsaXN0ZW5lcnMgPSBldmVudHNbZXZlbnRdO1xuICAgICAgICAgICAgaWYgKCFsaXN0ZW5lcnMpIHtcbiAgICAgICAgICAgICAgICBsaXN0ZW5lcnMgPSBldmVudHNbZXZlbnRdID0ge307XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICB2YXIgaWQgPSBjb3VudCsrO1xuICAgICAgICAgICAgbGlzdGVuZXJzW2lkKytdID0gY2FsbGJhY2s7XG4gICAgICAgICAgICByZXR1cm4gZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgIGRlbGV0ZSBsaXN0ZW5lcnNbaWRdO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuICAgIGZ1bmN0aW9uIGdldENvbnNvbGUoKSB7XG4gICAgICAgIC8vIHRvIGhlbHAgd2l0aCBkZWJ1Z2dpbmcgZm9yIG5vdyB1bnRpbCB3ZSBvcHQgZm9yIGEgbmljZSBsb2dnZXIuIEluIHByb2R1Y3Rpb24sIGxvZyBhbmQgZGVidWcgc2hvdWxkIGF1dG9tYXRpY2FsbHkgYmUgcmVtb3ZlZCBieSB0aGUgYnVpbGQgZnJvbSB0aGUgY29kZS4uLi4gVE9ETzpuZWVkIHRvIGNoZWNrIG91dCB0aGUgcHJvZHVjdGlvbiBjb2RlXG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBsb2c6IGZ1bmN0aW9uIChtc2cpIHtcbiAgICAgICAgICAgICAgICB3aW5kb3cuY29uc29sZS5kZWJ1ZygnU1lOQyhpbmZvKTogJyArIG1zZyk7XG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgZGVidWc6IGZ1bmN0aW9uIChtc2cpIHtcbiAgICAgICAgICAgICAgICAvLyAgd2luZG93LmNvbnNvbGUuZGVidWcoJ1NZTkMoZGVidWcpOiAnICsgbXNnKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfTtcbiAgICB9XG59O1xuXG4iXSwic291cmNlUm9vdCI6Ii9zb3VyY2UvIn0=
