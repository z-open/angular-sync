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
    var SYNC_VERSION = '1.1';
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
        var timestampField, isSyncingOn = false, isSingle, updateDataStorage, cache, isInitialPushCompleted, deferredInitialization;
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

//# sourceMappingURL=data:application/json;charset=utf8;base64,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UUFBQSxRQUFBLFVBQUEsS0FBQSxFQUFBLE9BQUEsT0FBQTs7O1FBR0EsU0FBQSxZQUFBLFFBQUE7O1lBRUEsSUFBQSxRQUFBLFVBQUEsT0FBQSxXQUFBO2dCQUNBLE9BQUEsT0FBQTs7WUFFQSxJQUFBLFFBQUEsVUFBQSxPQUFBLFlBQUE7Z0JBQ0EsT0FBQSxPQUFBOztZQUVBLE1BQUEsSUFBQSxNQUFBLGlFQUFBLGNBQUEsYUFBQSxZQUFBLE9BQUEsTUFBQTs7Ozs7OztJQU9BLFNBQUEsZUFBQTtRQUNBLElBQUEsU0FBQTtRQUNBLElBQUEsUUFBQTs7UUFFQSxLQUFBLFNBQUE7UUFDQSxLQUFBLEtBQUE7O1FBRUEsU0FBQSxPQUFBLE9BQUEsT0FBQSxPQUFBO1lBQ0EsSUFBQSxZQUFBLE9BQUE7WUFDQSxJQUFBLFdBQUE7Z0JBQ0EsRUFBQSxRQUFBLFdBQUEsVUFBQSxVQUFBLElBQUE7b0JBQ0EsU0FBQSxPQUFBOzs7Ozs7OztRQVFBLFNBQUEsR0FBQSxPQUFBLFVBQUE7WUFDQSxJQUFBLFlBQUEsT0FBQTtZQUNBLElBQUEsQ0FBQSxXQUFBO2dCQUNBLFlBQUEsT0FBQSxTQUFBOztZQUVBLElBQUEsS0FBQTtZQUNBLFVBQUEsUUFBQTtZQUNBLE9BQUEsWUFBQTtnQkFDQSxPQUFBLFVBQUE7Ozs7SUFJQSxTQUFBLGFBQUE7O1FBRUEsT0FBQTtZQUNBLEtBQUEsVUFBQSxLQUFBO2dCQUNBLE9BQUEsUUFBQSxNQUFBLGlCQUFBOztZQUVBLE9BQUEsVUFBQSxLQUFBOzs7OztDQUtBOztBQUVBIiwiZmlsZSI6ImFuZ3VsYXItc3luYy5qcyIsInNvdXJjZXNDb250ZW50IjpbIihmdW5jdGlvbigpIHtcblwidXNlIHN0cmljdFwiO1xuXG5hbmd1bGFyXG4gICAgLm1vZHVsZSgnc3luYycsIFsnc29ja2V0aW8tYXV0aCddKVxuICAgIC5jb25maWcoZnVuY3Rpb24oJHNvY2tldGlvUHJvdmlkZXIpe1xuICAgICAgICAkc29ja2V0aW9Qcm92aWRlci5zZXREZWJ1Zyh0cnVlKTtcbiAgICB9KTtcbn0oKSk7XG5cbihmdW5jdGlvbigpIHtcblwidXNlIHN0cmljdFwiO1xuXG5hbmd1bGFyXG4gICAgLm1vZHVsZSgnc3luYycpXG4gICAgLmZhY3RvcnkoJyRzeW5jR2FyYmFnZUNvbGxlY3RvcicsIHN5bmNHYXJiYWdlQ29sbGVjdG9yKTtcblxuLyoqXG4gKiBzYWZlbHkgcmVtb3ZlIGRlbGV0ZWQgcmVjb3JkL29iamVjdCBmcm9tIG1lbW9yeSBhZnRlciB0aGUgc3luYyBwcm9jZXNzIGRpc3Bvc2VkIHRoZW0uXG4gKiBcbiAqIFRPRE86IFNlY29uZHMgc2hvdWxkIHJlZmxlY3QgdGhlIG1heCB0aW1lICB0aGF0IHN5bmMgY2FjaGUgaXMgdmFsaWQgKG5ldHdvcmsgbG9zcyB3b3VsZCBmb3JjZSBhIHJlc3luYyksIHdoaWNoIHNob3VsZCBtYXRjaCBtYXhEaXNjb25uZWN0aW9uVGltZUJlZm9yZURyb3BwaW5nU3Vic2NyaXB0aW9uIG9uIHRoZSBzZXJ2ZXIgc2lkZS5cbiAqIFxuICogTm90ZTpcbiAqIHJlbW92ZWQgcmVjb3JkIHNob3VsZCBiZSBkZWxldGVkIGZyb20gdGhlIHN5bmMgaW50ZXJuYWwgY2FjaGUgYWZ0ZXIgYSB3aGlsZSBzbyB0aGF0IHRoZXkgZG8gbm90IHN0YXkgaW4gdGhlIG1lbW9yeS4gVGhleSBjYW5ub3QgYmUgcmVtb3ZlZCB0b28gZWFybHkgYXMgYW4gb2xkZXIgdmVyc2lvbi9zdGFtcCBvZiB0aGUgcmVjb3JkIGNvdWxkIGJlIHJlY2VpdmVkIGFmdGVyIGl0cyByZW1vdmFsLi4ud2hpY2ggd291bGQgcmUtYWRkIHRvIGNhY2hlLi4uZHVlIGFzeW5jaHJvbm91cyBwcm9jZXNzaW5nLi4uXG4gKi9cbmZ1bmN0aW9uIHN5bmNHYXJiYWdlQ29sbGVjdG9yKCkge1xuICAgIHZhciBpdGVtcyA9IFtdO1xuICAgIHZhciBzZWNvbmRzID0gMjtcbiAgICB2YXIgc2NoZWR1bGVkID0gZmFsc2U7XG5cbiAgICB2YXIgc2VydmljZSA9IHtcbiAgICAgICAgc2V0U2Vjb25kczogc2V0U2Vjb25kcyxcbiAgICAgICAgZ2V0U2Vjb25kczogZ2V0U2Vjb25kcyxcbiAgICAgICAgZGlzcG9zZTogZGlzcG9zZSxcbiAgICAgICAgc2NoZWR1bGU6IHNjaGVkdWxlLFxuICAgICAgICBydW46IHJ1bixcbiAgICAgICAgZ2V0SXRlbUNvdW50OiBnZXRJdGVtQ291bnRcbiAgICB9O1xuXG4gICAgcmV0dXJuIHNlcnZpY2U7XG5cbiAgICAvLy8vLy8vLy8vXG5cbiAgICBmdW5jdGlvbiBzZXRTZWNvbmRzKHZhbHVlKSB7XG4gICAgICAgIHNlY29uZHMgPSB2YWx1ZTtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBnZXRTZWNvbmRzKCkge1xuICAgICAgICByZXR1cm4gc2Vjb25kcztcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBnZXRJdGVtQ291bnQoKSB7XG4gICAgICAgIHJldHVybiBpdGVtcy5sZW5ndGg7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gZGlzcG9zZShjb2xsZWN0KSB7XG4gICAgICAgIGl0ZW1zLnB1c2goe1xuICAgICAgICAgICAgdGltZXN0YW1wOiBEYXRlLm5vdygpLFxuICAgICAgICAgICAgY29sbGVjdDogY29sbGVjdFxuICAgICAgICB9KTtcbiAgICAgICAgaWYgKCFzY2hlZHVsZWQpIHtcbiAgICAgICAgICAgIHNlcnZpY2Uuc2NoZWR1bGUoKTtcbiAgICAgICAgfVxuICAgIH1cblxuICAgIGZ1bmN0aW9uIHNjaGVkdWxlKCkge1xuICAgICAgICBpZiAoIXNlY29uZHMpIHtcbiAgICAgICAgICAgIHNlcnZpY2UucnVuKCk7XG4gICAgICAgICAgICByZXR1cm47XG4gICAgICAgIH1cbiAgICAgICAgc2NoZWR1bGVkID0gdHJ1ZTtcbiAgICAgICAgc2V0VGltZW91dChmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICBzZXJ2aWNlLnJ1bigpO1xuICAgICAgICAgICAgaWYgKGl0ZW1zLmxlbmd0aCA+IDApIHtcbiAgICAgICAgICAgICAgICBzY2hlZHVsZSgpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBzY2hlZHVsZWQgPSBmYWxzZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSwgc2Vjb25kcyAqIDEwMDApO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIHJ1bigpIHtcbiAgICAgICAgdmFyIHRpbWVvdXQgPSBEYXRlLm5vdygpIC0gc2Vjb25kcyAqIDEwMDA7XG4gICAgICAgIHdoaWxlIChpdGVtcy5sZW5ndGggPiAwICYmIGl0ZW1zWzBdLnRpbWVzdGFtcCA8PSB0aW1lb3V0KSB7XG4gICAgICAgICAgICBpdGVtcy5zaGlmdCgpLmNvbGxlY3QoKTtcbiAgICAgICAgfVxuICAgIH1cbn1cbn0oKSk7XG5cbihmdW5jdGlvbigpIHtcblwidXNlIHN0cmljdFwiO1xuXG4vKipcbiAqIFxuICogU2VydmljZSB0aGF0IGFsbG93cyBhbiBhcnJheSBvZiBkYXRhIHJlbWFpbiBpbiBzeW5jIHdpdGggYmFja2VuZC5cbiAqIFxuICogXG4gKiBleDpcbiAqIHdoZW4gdGhlcmUgaXMgYSBub3RpZmljYXRpb24sIG5vdGljYXRpb25TZXJ2aWNlIG5vdGlmaWVzIHRoYXQgdGhlcmUgaXMgc29tZXRoaW5nIG5ldy4uLnRoZW4gdGhlIGRhdGFzZXQgZ2V0IHRoZSBkYXRhIGFuZCBub3RpZmllcyBhbGwgaXRzIGNhbGxiYWNrLlxuICogXG4gKiBOT1RFOiBcbiAqICBcbiAqIFxuICogUHJlLVJlcXVpc3RlOlxuICogLS0tLS0tLS0tLS0tLVxuICogU3luYyBkb2VzIG5vdCB3b3JrIGlmIG9iamVjdHMgZG8gbm90IGhhdmUgQk9USCBpZCBhbmQgcmV2aXNpb24gZmllbGQhISEhXG4gKiBcbiAqIFdoZW4gdGhlIGJhY2tlbmQgd3JpdGVzIGFueSBkYXRhIHRvIHRoZSBkYiB0aGF0IGFyZSBzdXBwb3NlZCB0byBiZSBzeW5jcm9uaXplZDpcbiAqIEl0IG11c3QgbWFrZSBzdXJlIGVhY2ggYWRkLCB1cGRhdGUsIHJlbW92YWwgb2YgcmVjb3JkIGlzIHRpbWVzdGFtcGVkLlxuICogSXQgbXVzdCBub3RpZnkgdGhlIGRhdGFzdHJlYW0gKHdpdGggbm90aWZ5Q2hhbmdlIG9yIG5vdGlmeVJlbW92YWwpIHdpdGggc29tZSBwYXJhbXMgc28gdGhhdCBiYWNrZW5kIGtub3dzIHRoYXQgaXQgaGFzIHRvIHB1c2ggYmFjayB0aGUgZGF0YSBiYWNrIHRvIHRoZSBzdWJzY3JpYmVycyAoZXg6IHRoZSB0YXNrQ3JlYXRpb24gd291bGQgbm90aWZ5IHdpdGggaXRzIHBsYW5JZClcbiogXG4gKiBcbiAqL1xuYW5ndWxhclxuICAgIC5tb2R1bGUoJ3N5bmMnKVxuICAgIC5mYWN0b3J5KCckc3luYycsIHN5bmMpO1xuXG5mdW5jdGlvbiBzeW5jKCRyb290U2NvcGUsICRxLCAkc29ja2V0aW8sICRzeW5jR2FyYmFnZUNvbGxlY3Rvcikge1xuICAgIHZhciBwdWJsaWNhdGlvbkxpc3RlbmVycyA9IHt9LFxuICAgICAgICBwdWJsaWNhdGlvbkxpc3RlbmVyQ291bnQgPSAwO1xuICAgIHZhciBHUkFDRV9QRVJJT0RfSU5fU0VDT05EUyA9IDg7XG4gICAgdmFyIFNZTkNfVkVSU0lPTiA9ICcxLjEnO1xuICAgIHZhciBjb25zb2xlID0gZ2V0Q29uc29sZSgpO1xuXG4gICAgbGlzdGVuVG9TeW5jTm90aWZpY2F0aW9uKCk7XG5cbiAgICB2YXIgc2VydmljZSA9IHtcbiAgICAgICAgc3Vic2NyaWJlOiBzdWJzY3JpYmUsXG4gICAgICAgIHJlc29sdmVTdWJzY3JpcHRpb246IHJlc29sdmVTdWJzY3JpcHRpb24sXG4gICAgICAgIGdldEdyYWNlUGVyaW9kOiBnZXRHcmFjZVBlcmlvZFxuICAgIH07XG5cbiAgICByZXR1cm4gc2VydmljZTtcblxuICAgIC8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vXG4gICAgLyoqXG4gICAgICogc3Vic2NyaWJlIHRvIHB1YmxpY2F0aW9uIGFuZCByZXR1cm5zIHRoZSBzdWJzY3JpcHRpb24gd2hlbiBkYXRhIGlzIGF2YWlsYWJsZS4gXG4gICAgICogQHBhcmFtIHB1YmxpY2F0aW9uIG5hbWUuIG9uIHRoZSBzZXJ2ZXIgc2lkZSwgYSBwdWJsaWNhdGlvbiBzaGFsbCBleGlzdC4gZXg6IG1hZ2F6aW5lcy5zeW5jXG4gICAgICogQHBhcmFtIHBhcmFtcyAgIHRoZSBwYXJhbXMgb2JqZWN0IHBhc3NlZCB0byB0aGUgc3Vic2NyaXB0aW9uLCBleDoge21hZ2F6aW5lSWQ6J2VudHJlcHJlbmV1cid9KVxuICAgICAqIEBwYXJhbSBvYmplY3RDbGFzcyBhbiBpbnN0YW5jZSBvZiB0aGlzIGNsYXNzIHdpbGwgYmUgY3JlYXRlZCBmb3IgZWFjaCByZWNvcmQgcmVjZWl2ZWQuXG4gICAgICogcmV0dXJucyBhIHByb21pc2UgcmV0dXJuaW5nIHRoZSBzdWJzY3JpcHRpb24gd2hlbiB0aGUgZGF0YSBpcyBzeW5jZWRcbiAgICAgKiBvciByZWplY3RzIGlmIHRoZSBpbml0aWFsIHN5bmMgZmFpbHMgdG8gY29tcGxldGUgaW4gYSBsaW1pdGVkIGFtb3VudCBvZiB0aW1lLiBcbiAgICAgKiBcbiAgICAgKiB0byBnZXQgdGhlIGRhdGEgZnJvbSB0aGUgZGF0YVNldCwganVzdCBkYXRhU2V0LmdldERhdGEoKVxuICAgICAqL1xuICAgIGZ1bmN0aW9uIHJlc29sdmVTdWJzY3JpcHRpb24ocHVibGljYXRpb25OYW1lLCBwYXJhbXMsIG9iamVjdENsYXNzKSB7XG4gICAgICAgIHZhciBkZWZlcnJlZCA9ICRxLmRlZmVyKCk7XG4gICAgICAgIHZhciBzRHMgPSBzdWJzY3JpYmUocHVibGljYXRpb25OYW1lKS5zZXRPYmplY3RDbGFzcyhvYmplY3RDbGFzcyk7XG5cbiAgICAgICAgLy8gZ2l2ZSBhIGxpdHRsZSB0aW1lIGZvciBzdWJzY3JpcHRpb24gdG8gZmV0Y2ggdGhlIGRhdGEuLi5vdGhlcndpc2UgZ2l2ZSB1cCBzbyB0aGF0IHdlIGRvbid0IGdldCBzdHVjayBpbiBhIHJlc29sdmUgd2FpdGluZyBmb3JldmVyLlxuICAgICAgICB2YXIgZ3JhY2VQZXJpb2QgPSBzZXRUaW1lb3V0KGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIGlmICghc0RzLnJlYWR5KSB7XG4gICAgICAgICAgICAgICAgc0RzLmRlc3Ryb3koKTtcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZygnQXR0ZW1wdCB0byBzdWJzY3JpYmUgdG8gcHVibGljYXRpb24gJyArIHB1YmxpY2F0aW9uTmFtZSArICcgZmFpbGVkJyk7XG4gICAgICAgICAgICAgICAgZGVmZXJyZWQucmVqZWN0KCdTWU5DX1RJTUVPVVQnKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSwgR1JBQ0VfUEVSSU9EX0lOX1NFQ09ORFMgKiAxMDAwKTtcblxuICAgICAgICBzRHMuc2V0UGFyYW1ldGVycyhwYXJhbXMpXG4gICAgICAgICAgICAud2FpdEZvckRhdGFSZWFkeSgpXG4gICAgICAgICAgICAudGhlbihmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgY2xlYXJUaW1lb3V0KGdyYWNlUGVyaW9kKTtcbiAgICAgICAgICAgICAgICBkZWZlcnJlZC5yZXNvbHZlKHNEcyk7XG4gICAgICAgICAgICB9KS5jYXRjaChmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgY2xlYXJUaW1lb3V0KGdyYWNlUGVyaW9kKTtcbiAgICAgICAgICAgICAgICBzRHMuZGVzdHJveSgpO1xuICAgICAgICAgICAgICAgIGRlZmVycmVkLnJlamVjdCgnRmFpbGVkIHRvIHN1YnNjcmliZSB0byBwdWJsaWNhdGlvbiAnICsgcHVibGljYXRpb25OYW1lICsgJyBmYWlsZWQnKTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICByZXR1cm4gZGVmZXJyZWQucHJvbWlzZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBcbiAgICAgKiBmb3IgdGVzdCBwdXJwb3NlcywgcmV0dXJucyB0aGUgdGltZSByZXNvbHZlU3Vic2NyaXB0aW9uIGJlZm9yZSBpdCB0aW1lcyBvdXQuXG4gICAgICovXG4gICAgZnVuY3Rpb24gZ2V0R3JhY2VQZXJpb2QoKSB7XG4gICAgICAgIHJldHVybiBHUkFDRV9QRVJJT0RfSU5fU0VDT05EUztcbiAgICB9XG4gICAgLyoqXG4gICAgICogc3Vic2NyaWJlIHRvIHB1YmxpY2F0aW9uLiBJdCB3aWxsIG5vdCBzeW5jIHVudGlsIHlvdSBzZXQgdGhlIHBhcmFtcy5cbiAgICAgKiBcbiAgICAgKiBAcGFyYW0gcHVibGljYXRpb24gbmFtZS4gb24gdGhlIHNlcnZlciBzaWRlLCBhIHB1YmxpY2F0aW9uIHNoYWxsIGV4aXN0LiBleDogbWFnYXppbmVzLnN5bmNcbiAgICAgKiBAcGFyYW0gcGFyYW1zICAgdGhlIHBhcmFtcyBvYmplY3QgcGFzc2VkIHRvIHRoZSBzdWJzY3JpcHRpb24sIGV4OiB7bWFnYXppbmVJZDonZW50cmVwcmVuZXVyJ30pXG4gICAgICogcmV0dXJucyBzdWJzY3JpcHRpb25cbiAgICAgKiBcbiAgICAgKi9cbiAgICBmdW5jdGlvbiBzdWJzY3JpYmUocHVibGljYXRpb25OYW1lLCBzY29wZSkge1xuICAgICAgICByZXR1cm4gbmV3IFN1YnNjcmlwdGlvbihwdWJsaWNhdGlvbk5hbWUsIHNjb3BlKTtcbiAgICB9XG5cblxuXG4gICAgLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy9cbiAgICAvLyBIRUxQRVJTXG5cbiAgICAvLyBldmVyeSBzeW5jIG5vdGlmaWNhdGlvbiBjb21lcyB0aHJ1IHRoZSBzYW1lIGV2ZW50IHRoZW4gaXQgaXMgZGlzcGF0Y2hlcyB0byB0aGUgdGFyZ2V0ZWQgc3Vic2NyaXB0aW9ucy5cbiAgICBmdW5jdGlvbiBsaXN0ZW5Ub1N5bmNOb3RpZmljYXRpb24oKSB7XG4gICAgICAgICRzb2NrZXRpby5vbignU1lOQ19OT1cnLCBmdW5jdGlvbiAoc3ViTm90aWZpY2F0aW9uLCBmbikge1xuICAgICAgICAgICAgY29uc29sZS5sb2coJ1N5bmNpbmcgd2l0aCBzdWJzY3JpcHRpb24gW25hbWU6JyArIHN1Yk5vdGlmaWNhdGlvbi5uYW1lICsgJywgaWQ6JyArIHN1Yk5vdGlmaWNhdGlvbi5zdWJzY3JpcHRpb25JZCArICcgLCBwYXJhbXM6JyArIEpTT04uc3RyaW5naWZ5KHN1Yk5vdGlmaWNhdGlvbi5wYXJhbXMpICsgJ10uIFJlY29yZHM6JyArIHN1Yk5vdGlmaWNhdGlvbi5yZWNvcmRzLmxlbmd0aCArICdbJyArIChzdWJOb3RpZmljYXRpb24uZGlmZiA/ICdEaWZmJyA6ICdBbGwnKSArICddJyk7XG4gICAgICAgICAgICB2YXIgbGlzdGVuZXJzID0gcHVibGljYXRpb25MaXN0ZW5lcnNbc3ViTm90aWZpY2F0aW9uLm5hbWVdO1xuICAgICAgICAgICAgaWYgKGxpc3RlbmVycykge1xuICAgICAgICAgICAgICAgIGZvciAodmFyIGxpc3RlbmVyIGluIGxpc3RlbmVycykge1xuICAgICAgICAgICAgICAgICAgICBsaXN0ZW5lcnNbbGlzdGVuZXJdKHN1Yk5vdGlmaWNhdGlvbik7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgZm4oJ1NZTkNFRCcpOyAvLyBsZXQga25vdyB0aGUgYmFja2VuZCB0aGUgY2xpZW50IHdhcyBhYmxlIHRvIHN5bmMuXG4gICAgICAgIH0pO1xuICAgIH07XG5cblxuICAgIC8vIHRoaXMgYWxsb3dzIGEgZGF0YXNldCB0byBsaXN0ZW4gdG8gYW55IFNZTkNfTk9XIGV2ZW50Li5hbmQgaWYgdGhlIG5vdGlmaWNhdGlvbiBpcyBhYm91dCBpdHMgZGF0YS5cbiAgICBmdW5jdGlvbiBhZGRQdWJsaWNhdGlvbkxpc3RlbmVyKHN0cmVhbU5hbWUsIGNhbGxiYWNrKSB7XG4gICAgICAgIHZhciB1aWQgPSBwdWJsaWNhdGlvbkxpc3RlbmVyQ291bnQrKztcbiAgICAgICAgdmFyIGxpc3RlbmVycyA9IHB1YmxpY2F0aW9uTGlzdGVuZXJzW3N0cmVhbU5hbWVdO1xuICAgICAgICBpZiAoIWxpc3RlbmVycykge1xuICAgICAgICAgICAgcHVibGljYXRpb25MaXN0ZW5lcnNbc3RyZWFtTmFtZV0gPSBsaXN0ZW5lcnMgPSB7fTtcbiAgICAgICAgfVxuICAgICAgICBsaXN0ZW5lcnNbdWlkXSA9IGNhbGxiYWNrO1xuXG4gICAgICAgIHJldHVybiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICBkZWxldGUgbGlzdGVuZXJzW3VpZF07XG4gICAgICAgIH1cbiAgICB9XG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gICAgLy8gU3Vic2NyaXB0aW9uIG9iamVjdFxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgIC8qKlxuICAgICAqIGEgc3Vic2NyaXB0aW9uIHN5bmNocm9uaXplcyB3aXRoIHRoZSBiYWNrZW5kIGZvciBhbnkgYmFja2VuZCBkYXRhIGNoYW5nZSBhbmQgbWFrZXMgdGhhdCBkYXRhIGF2YWlsYWJsZSB0byBhIGNvbnRyb2xsZXIuXG4gICAgICogXG4gICAgICogIFdoZW4gY2xpZW50IHN1YnNjcmliZXMgdG8gYW4gc3luY3Jvbml6ZWQgYXBpLCBhbnkgZGF0YSBjaGFuZ2UgdGhhdCBpbXBhY3RzIHRoZSBhcGkgcmVzdWx0IFdJTEwgYmUgUFVTSGVkIHRvIHRoZSBjbGllbnQuXG4gICAgICogSWYgdGhlIGNsaWVudCBkb2VzIE5PVCBzdWJzY3JpYmUgb3Igc3RvcCBzdWJzY3JpYmUsIGl0IHdpbGwgbm8gbG9uZ2VyIHJlY2VpdmUgdGhlIFBVU0guIFxuICAgICAqICAgIFxuICAgICAqIGlmIHRoZSBjb25uZWN0aW9uIGlzIGxvc3QgZm9yIGEgc2hvcnQgdGltZSAoZHVyYXRpb24gZGVmaW5lZCBvbiBzZXJ2ZXItc2lkZSksIHRoZSBzZXJ2ZXIgcXVldWVzIHRoZSBjaGFuZ2VzIGlmIGFueS4gXG4gICAgICogV2hlbiB0aGUgY29ubmVjdGlvbiByZXR1cm5zLCB0aGUgbWlzc2luZyBkYXRhIGF1dG9tYXRpY2FsbHkgIHdpbGwgYmUgUFVTSGVkIHRvIHRoZSBzdWJzY3JpYmluZyBjbGllbnQuXG4gICAgICogaWYgdGhlIGNvbm5lY3Rpb24gaXMgbG9zdCBmb3IgYSBsb25nIHRpbWUgKGR1cmF0aW9uIGRlZmluZWQgb24gdGhlIHNlcnZlciksIHRoZSBzZXJ2ZXIgd2lsbCBkZXN0cm95IHRoZSBzdWJzY3JpcHRpb24uIFRvIHNpbXBsaWZ5LCB0aGUgY2xpZW50IHdpbGwgcmVzdWJzY3JpYmUgYXQgaXRzIHJlY29ubmVjdGlvbiBhbmQgZ2V0IGFsbCBkYXRhLlxuICAgICAqIFxuICAgICAqIHN1YnNjcmlwdGlvbiBvYmplY3QgcHJvdmlkZXMgMyBjYWxsYmFja3MgKGFkZCx1cGRhdGUsIGRlbCkgd2hpY2ggYXJlIGNhbGxlZCBkdXJpbmcgc3luY2hyb25pemF0aW9uLlxuICAgICAqICAgICAgXG4gICAgICogU2NvcGUgd2lsbCBhbGxvdyB0aGUgc3Vic2NyaXB0aW9uIHN0b3Agc3luY2hyb25pemluZyBhbmQgY2FuY2VsIHJlZ2lzdHJhdGlvbiB3aGVuIGl0IGlzIGRlc3Ryb3llZC4gXG4gICAgICogIFxuICAgICAqIENvbnN0cnVjdG9yOlxuICAgICAqIFxuICAgICAqIEBwYXJhbSBwdWJsaWNhdGlvbiwgdGhlIHB1YmxpY2F0aW9uIG11c3QgZXhpc3Qgb24gdGhlIHNlcnZlciBzaWRlXG4gICAgICogQHBhcmFtIHNjb3BlLCBieSBkZWZhdWx0ICRyb290U2NvcGUsIGJ1dCBjYW4gYmUgbW9kaWZpZWQgbGF0ZXIgb24gd2l0aCBhdHRhY2ggbWV0aG9kLlxuICAgICAqL1xuXG4gICAgZnVuY3Rpb24gU3Vic2NyaXB0aW9uKHB1YmxpY2F0aW9uLCBzY29wZSkge1xuICAgICAgICB2YXIgdGltZXN0YW1wRmllbGQsIGlzU3luY2luZ09uID0gZmFsc2UsIGlzU2luZ2xlLCB1cGRhdGVEYXRhU3RvcmFnZSwgY2FjaGUsIGlzSW5pdGlhbFB1c2hDb21wbGV0ZWQsIGRlZmVycmVkSW5pdGlhbGl6YXRpb247XG4gICAgICAgIHZhciBvblJlYWR5T2ZmLCBmb3JtYXRSZWNvcmQ7XG4gICAgICAgIHZhciByZWNvbm5lY3RPZmYsIHB1YmxpY2F0aW9uTGlzdGVuZXJPZmYsIGRlc3Ryb3lPZmY7XG4gICAgICAgIHZhciBvYmplY3RDbGFzcztcbiAgICAgICAgdmFyIHN1YnNjcmlwdGlvbklkO1xuICAgICAgICBcbiAgICAgICAgdmFyIHNEcyA9IHRoaXM7XG4gICAgICAgIHZhciBzdWJQYXJhbXMgPSB7fTtcbiAgICAgICAgdmFyIHJlY29yZFN0YXRlcyA9IHt9O1xuICAgICAgICB2YXIgaW5uZXJTY29wZTsvLz0gJHJvb3RTY29wZS4kbmV3KHRydWUpO1xuICAgICAgICB2YXIgc3luY0xpc3RlbmVyID0gbmV3IFN5bmNMaXN0ZW5lcigpO1xuICAgICAgICBcblxuICAgICAgICB0aGlzLnJlYWR5ID0gZmFsc2U7XG4gICAgICAgIHRoaXMuc3luY09uID0gc3luY09uO1xuICAgICAgICB0aGlzLnN5bmNPZmYgPSBzeW5jT2ZmO1xuICAgICAgICB0aGlzLnNldE9uUmVhZHkgPSBzZXRPblJlYWR5O1xuXG4gICAgICAgIHRoaXMub25SZWFkeSA9IG9uUmVhZHk7XG4gICAgICAgIHRoaXMub25VcGRhdGUgPSBvblVwZGF0ZTtcbiAgICAgICAgdGhpcy5vbkFkZCA9IG9uQWRkO1xuICAgICAgICB0aGlzLm9uUmVtb3ZlID0gb25SZW1vdmU7XG5cbiAgICAgICAgdGhpcy5nZXREYXRhID0gZ2V0RGF0YTtcbiAgICAgICAgdGhpcy5zZXRQYXJhbWV0ZXJzID0gc2V0UGFyYW1ldGVycztcblxuICAgICAgICB0aGlzLndhaXRGb3JEYXRhUmVhZHkgPSB3YWl0Rm9yRGF0YVJlYWR5O1xuICAgICAgICB0aGlzLndhaXRGb3JTdWJzY3JpcHRpb25SZWFkeSA9IHdhaXRGb3JTdWJzY3JpcHRpb25SZWFkeTtcblxuICAgICAgICB0aGlzLnNldEZvcmNlID0gc2V0Rm9yY2U7XG4gICAgICAgIHRoaXMuaXNTeW5jaW5nID0gaXNTeW5jaW5nO1xuICAgICAgICB0aGlzLmlzUmVhZHkgPSBpc1JlYWR5O1xuXG4gICAgICAgIHRoaXMuc2V0U2luZ2xlID0gc2V0U2luZ2xlO1xuXG4gICAgICAgIHRoaXMuc2V0T2JqZWN0Q2xhc3MgPSBzZXRPYmplY3RDbGFzcztcbiAgICAgICAgdGhpcy5nZXRPYmplY3RDbGFzcyA9IGdldE9iamVjdENsYXNzO1xuXG4gICAgICAgIHRoaXMuYXR0YWNoID0gYXR0YWNoO1xuICAgICAgICB0aGlzLmRlc3Ryb3kgPSBkZXN0cm95O1xuXG4gICAgICAgIHRoaXMuaXNFeGlzdGluZ1N0YXRlRm9yID0gaXNFeGlzdGluZ1N0YXRlRm9yOyAvLyBmb3IgdGVzdGluZyBwdXJwb3Nlc1xuXG4gICAgICAgIHNldFNpbmdsZShmYWxzZSk7XG5cbiAgICAgICAgLy8gdGhpcyB3aWxsIG1ha2Ugc3VyZSB0aGF0IHRoZSBzdWJzY3JpcHRpb24gaXMgcmVsZWFzZWQgZnJvbSBzZXJ2ZXJzIGlmIHRoZSBhcHAgY2xvc2VzIChjbG9zZSBicm93c2VyLCByZWZyZXNoLi4uKVxuICAgICAgICBhdHRhY2goc2NvcGUgfHwgJHJvb3RTY29wZSk7XG5cbiAgICAgICAgLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vL1xuXG4gICAgICAgIGZ1bmN0aW9uIGRlc3Ryb3koKSB7XG4gICAgICAgICAgICBzeW5jT2ZmKCk7XG4gICAgICAgIH1cblxuICAgICAgICAvKiogdGhpcyB3aWxsIGJlIGNhbGxlZCB3aGVuIGRhdGEgaXMgYXZhaWxhYmxlIFxuICAgICAgICAgKiAgaXQgbWVhbnMgcmlnaHQgYWZ0ZXIgZWFjaCBzeW5jIVxuICAgICAgICAgKiBcbiAgICAgICAgICogXG4gICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIHNldE9uUmVhZHkoY2FsbGJhY2spIHtcbiAgICAgICAgICAgIGlmIChvblJlYWR5T2ZmKSB7XG4gICAgICAgICAgICAgICAgb25SZWFkeU9mZigpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgb25SZWFkeU9mZiA9IG9uUmVhZHkoY2FsbGJhY2spO1xuICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgfVxuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiBmb3JjZSByZXN5bmNpbmcgZnJvbSBzY3JhdGNoIGV2ZW4gaWYgdGhlIHBhcmFtZXRlcnMgaGF2ZSBub3QgY2hhbmdlZFxuICAgICAgICAgKiBcbiAgICAgICAgICogaWYgb3V0c2lkZSBjb2RlIGhhcyBtb2RpZmllZCB0aGUgZGF0YSBhbmQgeW91IG5lZWQgdG8gcm9sbGJhY2ssIHlvdSBjb3VsZCBjb25zaWRlciBmb3JjaW5nIGEgcmVmcmVzaCB3aXRoIHRoaXMuIEJldHRlciBzb2x1dGlvbiBzaG91bGQgYmUgZm91bmQgdGhhbiB0aGF0LlxuICAgICAgICAgKiBcbiAgICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIHNldEZvcmNlKHZhbHVlKSB7XG4gICAgICAgICAgICBpZiAodmFsdWUpIHtcbiAgICAgICAgICAgICAgICAvLyBxdWljayBoYWNrIHRvIGZvcmNlIHRvIHJlbG9hZC4uLnJlY29kZSBsYXRlci5cbiAgICAgICAgICAgICAgICBzRHMuc3luY09mZigpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgfVxuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiBUaGUgZm9sbG93aW5nIG9iamVjdCB3aWxsIGJlIGJ1aWx0IHVwb24gZWFjaCByZWNvcmQgcmVjZWl2ZWQgZnJvbSB0aGUgYmFja2VuZFxuICAgICAgICAgKiBcbiAgICAgICAgICogVGhpcyBjYW5ub3QgYmUgbW9kaWZpZWQgYWZ0ZXIgdGhlIHN5bmMgaGFzIHN0YXJ0ZWQuXG4gICAgICAgICAqIFxuICAgICAgICAgKiBAcGFyYW0gY2xhc3NWYWx1ZVxuICAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gc2V0T2JqZWN0Q2xhc3MoY2xhc3NWYWx1ZSkge1xuICAgICAgICAgICAgaWYgKGRlZmVycmVkSW5pdGlhbGl6YXRpb24pIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICAgICAgfVxuXG4gICAgICAgICAgICBvYmplY3RDbGFzcyA9IGNsYXNzVmFsdWU7XG4gICAgICAgICAgICBmb3JtYXRSZWNvcmQgPSBmdW5jdGlvbiAocmVjb3JkKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIG5ldyBvYmplY3RDbGFzcyhyZWNvcmQpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgc2V0U2luZ2xlKGlzU2luZ2xlKTtcbiAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiBnZXRPYmplY3RDbGFzcygpIHtcbiAgICAgICAgICAgIHJldHVybiBvYmplY3RDbGFzcztcbiAgICAgICAgfVxuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiB0aGlzIGZ1bmN0aW9uIHN0YXJ0cyB0aGUgc3luY2luZy5cbiAgICAgICAgICogT25seSBwdWJsaWNhdGlvbiBwdXNoaW5nIGRhdGEgbWF0Y2hpbmcgb3VyIGZldGNoaW5nIHBhcmFtcyB3aWxsIGJlIHJlY2VpdmVkLlxuICAgICAgICAgKiBcbiAgICAgICAgICogZXg6IGZvciBhIHB1YmxpY2F0aW9uIG5hbWVkIFwibWFnYXppbmVzLnN5bmNcIiwgaWYgZmV0Y2hpbmcgcGFyYW1zIGVxdWFsbGVkIHttYWdhemluTmFtZTonY2Fycyd9LCB0aGUgbWFnYXppbmUgY2FycyBkYXRhIHdvdWxkIGJlIHJlY2VpdmVkIGJ5IHRoaXMgc3Vic2NyaXB0aW9uLlxuICAgICAgICAgKiBcbiAgICAgICAgICogQHBhcmFtIGZldGNoaW5nUGFyYW1zXG4gICAgICAgICAqIEBwYXJhbSBvcHRpb25zXG4gICAgICAgICAqIFxuICAgICAgICAgKiBAcmV0dXJucyBhIHByb21pc2UgdGhhdCByZXNvbHZlcyB3aGVuIGRhdGEgaXMgYXJyaXZlZC5cbiAgICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIHNldFBhcmFtZXRlcnMoZmV0Y2hpbmdQYXJhbXMsIG9wdGlvbnMpIHtcbiAgICAgICAgICAgIGlmIChpc1N5bmNpbmdPbiAmJiBhbmd1bGFyLmVxdWFscyhmZXRjaGluZ1BhcmFtcywgc3ViUGFyYW1zKSkge1xuICAgICAgICAgICAgICAgIC8vIGlmIHRoZSBwYXJhbXMgaGF2ZSBub3QgY2hhbmdlZCwganVzdCByZXR1cm5zIHdpdGggY3VycmVudCBkYXRhLlxuICAgICAgICAgICAgICAgIHJldHVybiBzRHM7IC8vJHEucmVzb2x2ZShnZXREYXRhKCkpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgc3luY09mZigpO1xuICAgICAgICAgICAgaWYgKCFpc1NpbmdsZSkge1xuICAgICAgICAgICAgICAgIGNhY2hlLmxlbmd0aCA9IDA7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIHN1YlBhcmFtcyA9IGZldGNoaW5nUGFyYW1zIHx8IHt9O1xuICAgICAgICAgICAgb3B0aW9ucyA9IG9wdGlvbnMgfHwge307XG4gICAgICAgICAgICBpZiAoYW5ndWxhci5pc0RlZmluZWQob3B0aW9ucy5zaW5nbGUpKSB7XG4gICAgICAgICAgICAgICAgc2V0U2luZ2xlKG9wdGlvbnMuc2luZ2xlKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHN5bmNPbigpO1xuICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIHdhaXQgZm9yIHRoZSBpbml0aWFsIGZldGNoIHRvIGNvbXBsZXRlIHRoZW4gcmV0dXJucyB0aGlzIHN1YnNjcmlwdGlvblxuICAgICAgICBmdW5jdGlvbiB3YWl0Rm9yU3Vic2NyaXB0aW9uUmVhZHkoKSB7XG4gICAgICAgICAgICByZXR1cm4gZGVmZXJyZWRJbml0aWFsaXphdGlvbi5wcm9taXNlLnRoZW4oZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIHdhaXQgZm9yIHRoZSBpbml0aWFsIGZldGNoIHRvIGNvbXBsZXRlIHRoZW4gcmV0dXJucyB0aGUgZGF0YVxuICAgICAgICBmdW5jdGlvbiB3YWl0Rm9yRGF0YVJlYWR5KCkge1xuICAgICAgICAgICAgcmV0dXJuIGRlZmVycmVkSW5pdGlhbGl6YXRpb24ucHJvbWlzZTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8vIGRvZXMgdGhlIGRhdGFzZXQgcmV0dXJucyBvbmx5IG9uZSBvYmplY3Q/IG5vdCBhbiBhcnJheT9cbiAgICAgICAgZnVuY3Rpb24gc2V0U2luZ2xlKHZhbHVlKSB7XG4gICAgICAgICAgICBpZiAoZGVmZXJyZWRJbml0aWFsaXphdGlvbikge1xuICAgICAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIGlzU2luZ2xlID0gdmFsdWU7XG4gICAgICAgICAgICBpZiAodmFsdWUpIHtcbiAgICAgICAgICAgICAgICB1cGRhdGVEYXRhU3RvcmFnZSA9IHVwZGF0ZVN5bmNlZE9iamVjdDtcbiAgICAgICAgICAgICAgICBjYWNoZSA9IG9iamVjdENsYXNzID8gbmV3IG9iamVjdENsYXNzKHt9KSA6IHt9O1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICB1cGRhdGVEYXRhU3RvcmFnZSA9IHVwZGF0ZVN5bmNlZEFycmF5O1xuICAgICAgICAgICAgICAgIGNhY2hlID0gW107XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gcmV0dXJucyB0aGUgb2JqZWN0IG9yIGFycmF5IGluIHN5bmNcbiAgICAgICAgZnVuY3Rpb24gZ2V0RGF0YSgpIHtcbiAgICAgICAgICAgIHJldHVybiBjYWNoZTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiB0aGUgZGF0YXNldCB3aWxsIHN0YXJ0IGxpc3RlbmluZyB0byB0aGUgZGF0YXN0cmVhbSBcbiAgICAgICAgICogXG4gICAgICAgICAqIE5vdGUgRHVyaW5nIHRoZSBzeW5jLCBpdCB3aWxsIGFsc28gY2FsbCB0aGUgb3B0aW9uYWwgY2FsbGJhY2tzIC0gYWZ0ZXIgcHJvY2Vzc2luZyBFQUNIIHJlY29yZCByZWNlaXZlZC5cbiAgICAgICAgICogXG4gICAgICAgICAqIEByZXR1cm5zIGEgcHJvbWlzZSB0aGF0IHdpbGwgYmUgcmVzb2x2ZWQgd2hlbiB0aGUgZGF0YSBpcyByZWFkeS5cbiAgICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIHN5bmNPbigpIHtcbiAgICAgICAgICAgIGlmIChpc1N5bmNpbmdPbikge1xuICAgICAgICAgICAgICAgIHJldHVybiBkZWZlcnJlZEluaXRpYWxpemF0aW9uLnByb21pc2U7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBkZWZlcnJlZEluaXRpYWxpemF0aW9uID0gJHEuZGVmZXIoKTtcbiAgICAgICAgICAgIGlzSW5pdGlhbFB1c2hDb21wbGV0ZWQgPSBmYWxzZTtcbiAgICAgICAgICAgIGNvbnNvbGUubG9nKCdTeW5jICcgKyBwdWJsaWNhdGlvbiArICcgb24uIFBhcmFtczonICsgSlNPTi5zdHJpbmdpZnkoc3ViUGFyYW1zKSk7XG4gICAgICAgICAgICBpc1N5bmNpbmdPbiA9IHRydWU7XG4gICAgICAgICAgICByZWdpc3RlclN1YnNjcmlwdGlvbigpO1xuICAgICAgICAgICAgcmVhZHlGb3JMaXN0ZW5pbmcoKTtcbiAgICAgICAgICAgIHJldHVybiBkZWZlcnJlZEluaXRpYWxpemF0aW9uLnByb21pc2U7XG4gICAgICAgIH1cblxuICAgICAgICAvKipcbiAgICAgICAgICogdGhlIGRhdGFzZXQgaXMgbm8gbG9uZ2VyIGxpc3RlbmluZyBhbmQgd2lsbCBub3QgY2FsbCBhbnkgY2FsbGJhY2tcbiAgICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIHN5bmNPZmYoKSB7XG4gICAgICAgICAgICBpZiAoZGVmZXJyZWRJbml0aWFsaXphdGlvbikge1xuICAgICAgICAgICAgICAgIC8vIGlmIHRoZXJlIGlzIGNvZGUgd2FpdGluZyBvbiB0aGlzIHByb21pc2UuLiBleCAobG9hZCBpbiByZXNvbHZlKVxuICAgICAgICAgICAgICAgIGRlZmVycmVkSW5pdGlhbGl6YXRpb24ucmVzb2x2ZShnZXREYXRhKCkpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKGlzU3luY2luZ09uKSB7XG4gICAgICAgICAgICAgICAgdW5yZWdpc3RlclN1YnNjcmlwdGlvbigpO1xuICAgICAgICAgICAgICAgIGlzU3luY2luZ09uID0gZmFsc2U7XG5cbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZygnU3luYyAnICsgcHVibGljYXRpb24gKyAnIG9mZi4gUGFyYW1zOicgKyBKU09OLnN0cmluZ2lmeShzdWJQYXJhbXMpKTtcbiAgICAgICAgICAgICAgICBpZiAocHVibGljYXRpb25MaXN0ZW5lck9mZikge1xuICAgICAgICAgICAgICAgICAgICBwdWJsaWNhdGlvbkxpc3RlbmVyT2ZmKCk7XG4gICAgICAgICAgICAgICAgICAgIHB1YmxpY2F0aW9uTGlzdGVuZXJPZmYgPSBudWxsO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBpZiAocmVjb25uZWN0T2ZmKSB7XG4gICAgICAgICAgICAgICAgICAgIHJlY29ubmVjdE9mZigpO1xuICAgICAgICAgICAgICAgICAgICByZWNvbm5lY3RPZmYgPSBudWxsO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIGlzU3luY2luZygpIHtcbiAgICAgICAgICAgIHJldHVybiBpc1N5bmNpbmdPbjtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIHJlYWR5Rm9yTGlzdGVuaW5nKCkge1xuICAgICAgICAgICAgaWYgKCFwdWJsaWNhdGlvbkxpc3RlbmVyT2ZmKSB7XG4gICAgICAgICAgICAgICAgbGlzdGVuRm9yUmVjb25uZWN0aW9uVG9SZXN5bmMoKTtcbiAgICAgICAgICAgICAgICBsaXN0ZW5Ub1B1YmxpY2F0aW9uKCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICAvKipcbiAgICAgICAgICogIEJ5IGRlZmF1bHQgdGhlIHJvb3RzY29wZSBpcyBhdHRhY2hlZCBpZiBubyBzY29wZSB3YXMgcHJvdmlkZWQuIEJ1dCBpdCBpcyBwb3NzaWJsZSB0byByZS1hdHRhY2ggaXQgdG8gYSBkaWZmZXJlbnQgc2NvcGUuIGlmIHRoZSBzdWJzY3JpcHRpb24gZGVwZW5kcyBvbiBhIGNvbnRyb2xsZXIuXG4gICAgICAgICAqXG4gICAgICAgICAqICBEbyBub3QgYXR0YWNoIGFmdGVyIGl0IGhhcyBzeW5jZWQuXG4gICAgICAgICAqL1xuICAgICAgICBmdW5jdGlvbiBhdHRhY2gobmV3U2NvcGUpIHtcbiAgICAgICAgICAgIGlmIChkZWZlcnJlZEluaXRpYWxpemF0aW9uKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChkZXN0cm95T2ZmKSB7XG4gICAgICAgICAgICAgICAgZGVzdHJveU9mZigpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaW5uZXJTY29wZSA9IG5ld1Njb3BlO1xuICAgICAgICAgICAgZGVzdHJveU9mZiA9IGlubmVyU2NvcGUuJG9uKCckZGVzdHJveScsIGRlc3Ryb3kpO1xuXG4gICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gbGlzdGVuRm9yUmVjb25uZWN0aW9uVG9SZXN5bmMobGlzdGVuTm93KSB7XG4gICAgICAgICAgICAvLyBnaXZlIGEgY2hhbmNlIHRvIGNvbm5lY3QgYmVmb3JlIGxpc3RlbmluZyB0byByZWNvbm5lY3Rpb24uLi4gQFRPRE8gc2hvdWxkIGhhdmUgdXNlcl9yZWNvbm5lY3RlZF9ldmVudFxuICAgICAgICAgICAgc2V0VGltZW91dChmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgcmVjb25uZWN0T2ZmID0gaW5uZXJTY29wZS4kb24oJ3VzZXJfY29ubmVjdGVkJywgZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgICAgICBjb25zb2xlLmRlYnVnKCdSZXN5bmNpbmcgYWZ0ZXIgbmV0d29yayBsb3NzIHRvICcgKyBwdWJsaWNhdGlvbik7XG4gICAgICAgICAgICAgICAgICAgIC8vIG5vdGUgdGhlIGJhY2tlbmQgbWlnaHQgcmV0dXJuIGEgbmV3IHN1YnNjcmlwdGlvbiBpZiB0aGUgY2xpZW50IHRvb2sgdG9vIG11Y2ggdGltZSB0byByZWNvbm5lY3QuXG4gICAgICAgICAgICAgICAgICAgIHJlZ2lzdGVyU3Vic2NyaXB0aW9uKCk7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9LCBsaXN0ZW5Ob3cgPyAwIDogMjAwMCk7XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiByZWdpc3RlclN1YnNjcmlwdGlvbigpIHtcbiAgICAgICAgICAgICRzb2NrZXRpby5mZXRjaCgnc3luYy5zdWJzY3JpYmUnLCB7XG4gICAgICAgICAgICAgICAgdmVyc2lvbjogU1lOQ19WRVJTSU9OLFxuICAgICAgICAgICAgICAgIGlkOiBzdWJzY3JpcHRpb25JZCwgLy8gdG8gdHJ5IHRvIHJlLXVzZSBleGlzdGluZyBzdWJjcmlwdGlvblxuICAgICAgICAgICAgICAgIHB1YmxpY2F0aW9uOiBwdWJsaWNhdGlvbixcbiAgICAgICAgICAgICAgICBwYXJhbXM6IHN1YlBhcmFtc1xuICAgICAgICAgICAgfSkudGhlbihmdW5jdGlvbiAoc3ViSWQpIHtcbiAgICAgICAgICAgICAgICBzdWJzY3JpcHRpb25JZCA9IHN1YklkO1xuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiB1bnJlZ2lzdGVyU3Vic2NyaXB0aW9uKCkge1xuICAgICAgICAgICAgaWYgKHN1YnNjcmlwdGlvbklkKSB7XG4gICAgICAgICAgICAgICAgJHNvY2tldGlvLmZldGNoKCdzeW5jLnVuc3Vic2NyaWJlJywge1xuICAgICAgICAgICAgICAgICAgICB2ZXJzaW9uOiBTWU5DX1ZFUlNJT04sXG4gICAgICAgICAgICAgICAgICAgIGlkOiBzdWJzY3JpcHRpb25JZFxuICAgICAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgICAgIHN1YnNjcmlwdGlvbklkID0gbnVsbDtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIGxpc3RlblRvUHVibGljYXRpb24oKSB7XG4gICAgICAgICAgICAvLyBjYW5ub3Qgb25seSBsaXN0ZW4gdG8gc3Vic2NyaXB0aW9uSWQgeWV0Li4uYmVjYXVzZSB0aGUgcmVnaXN0cmF0aW9uIG1pZ2h0IGhhdmUgYW5zd2VyIHByb3ZpZGVkIGl0cyBpZCB5ZXQuLi5idXQgc3RhcnRlZCBicm9hZGNhc3RpbmcgY2hhbmdlcy4uLkBUT0RPIGNhbiBiZSBpbXByb3ZlZC4uLlxuICAgICAgICAgICAgcHVibGljYXRpb25MaXN0ZW5lck9mZiA9IGFkZFB1YmxpY2F0aW9uTGlzdGVuZXIocHVibGljYXRpb24sIGZ1bmN0aW9uIChiYXRjaCkge1xuICAgICAgICAgICAgICAgIGlmIChzdWJzY3JpcHRpb25JZCA9PT0gYmF0Y2guc3Vic2NyaXB0aW9uSWQgfHwgKCFzdWJzY3JpcHRpb25JZCAmJiBjaGVja0RhdGFTZXRQYXJhbXNJZk1hdGNoaW5nQmF0Y2hQYXJhbXMoYmF0Y2gucGFyYW1zKSkpIHtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFiYXRjaC5kaWZmKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICAvLyBDbGVhciB0aGUgY2FjaGUgdG8gcmVidWlsZCBpdCBpZiBhbGwgZGF0YSB3YXMgcmVjZWl2ZWQuXG4gICAgICAgICAgICAgICAgICAgICAgICByZWNvcmRTdGF0ZXMgPSB7fTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmICghaXNTaW5nbGUpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBjYWNoZS5sZW5ndGggPSAwO1xuICAgICAgICAgICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIGFwcGx5Q2hhbmdlcyhiYXRjaC5yZWNvcmRzKTtcbiAgICAgICAgICAgICAgICAgICAgaWYgKCFpc0luaXRpYWxQdXNoQ29tcGxldGVkKSB7XG4gICAgICAgICAgICAgICAgICAgICAgICBpc0luaXRpYWxQdXNoQ29tcGxldGVkID0gdHJ1ZTtcbiAgICAgICAgICAgICAgICAgICAgICAgIGRlZmVycmVkSW5pdGlhbGl6YXRpb24ucmVzb2x2ZShnZXREYXRhKCkpO1xuICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSk7XG4gICAgICAgIH1cblxuICAgICAgICAvKipcbiAgICAgICAgKiBpZiB0aGUgcGFyYW1zIG9mIHRoZSBkYXRhc2V0IG1hdGNoZXMgdGhlIG5vdGlmaWNhdGlvbiwgaXQgbWVhbnMgdGhlIGRhdGEgbmVlZHMgdG8gYmUgY29sbGVjdCB0byB1cGRhdGUgYXJyYXkuXG4gICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIGNoZWNrRGF0YVNldFBhcmFtc0lmTWF0Y2hpbmdCYXRjaFBhcmFtcyhiYXRjaFBhcmFtcykge1xuICAgICAgICAgICAgLy8gaWYgKHBhcmFtcy5sZW5ndGggIT0gc3RyZWFtUGFyYW1zLmxlbmd0aCkge1xuICAgICAgICAgICAgLy8gICAgIHJldHVybiBmYWxzZTtcbiAgICAgICAgICAgIC8vIH1cbiAgICAgICAgICAgIGlmICghc3ViUGFyYW1zIHx8IE9iamVjdC5rZXlzKHN1YlBhcmFtcykubGVuZ3RoID09IDApIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gdHJ1ZVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdmFyIG1hdGNoaW5nID0gdHJ1ZTtcbiAgICAgICAgICAgIGZvciAodmFyIHBhcmFtIGluIGJhdGNoUGFyYW1zKSB7XG4gICAgICAgICAgICAgICAgLy8gYXJlIG90aGVyIHBhcmFtcyBtYXRjaGluZz9cbiAgICAgICAgICAgICAgICAvLyBleDogd2UgbWlnaHQgaGF2ZSByZWNlaXZlIGEgbm90aWZpY2F0aW9uIGFib3V0IHRhc2tJZD0yMCBidXQgdGhpcyBzdWJzY3JpcHRpb24gYXJlIG9ubHkgaW50ZXJlc3RlZCBhYm91dCB0YXNrSWQtM1xuICAgICAgICAgICAgICAgIGlmIChiYXRjaFBhcmFtc1twYXJhbV0gIT09IHN1YlBhcmFtc1twYXJhbV0pIHtcbiAgICAgICAgICAgICAgICAgICAgbWF0Y2hpbmcgPSBmYWxzZTtcbiAgICAgICAgICAgICAgICAgICAgYnJlYWs7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgcmV0dXJuIG1hdGNoaW5nO1xuXG4gICAgICAgIH1cblxuICAgICAgICAvLyBmZXRjaCBhbGwgdGhlIG1pc3NpbmcgcmVjb3JkcywgYW5kIGFjdGl2YXRlIHRoZSBjYWxsIGJhY2tzIChhZGQsdXBkYXRlLHJlbW92ZSkgYWNjb3JkaW5nbHkgaWYgdGhlcmUgaXMgc29tZXRoaW5nIHRoYXQgaXMgbmV3IG9yIG5vdCBhbHJlYWR5IGluIHN5bmMuXG4gICAgICAgIGZ1bmN0aW9uIGFwcGx5Q2hhbmdlcyhyZWNvcmRzKSB7XG4gICAgICAgICAgICB2YXIgbmV3RGF0YUFycmF5ID0gW107XG4gICAgICAgICAgICB2YXIgbmV3RGF0YTtcbiAgICAgICAgICAgIHNEcy5yZWFkeSA9IGZhbHNlO1xuICAgICAgICAgICAgcmVjb3Jkcy5mb3JFYWNoKGZ1bmN0aW9uIChyZWNvcmQpIHtcbiAgICAgICAgICAgICAgICAvLyAgICAgICAgICAgICAgICAgICBjb25zb2xlLmxvZygnRGF0YXN5bmMgWycgKyBkYXRhU3RyZWFtTmFtZSArICddIHJlY2VpdmVkOicgK0pTT04uc3RyaW5naWZ5KHJlY29yZCkpOy8vKyByZWNvcmQuaWQpO1xuICAgICAgICAgICAgICAgIGlmIChyZWNvcmQucmVtb3ZlKSB7XG4gICAgICAgICAgICAgICAgICAgIHJlbW92ZVJlY29yZChyZWNvcmQpO1xuICAgICAgICAgICAgICAgIH0gZWxzZSBpZiAocmVjb3JkU3RhdGVzW3JlY29yZC5pZF0pIHtcbiAgICAgICAgICAgICAgICAgICAgLy8gaWYgdGhlIHJlY29yZCBpcyBhbHJlYWR5IHByZXNlbnQgaW4gdGhlIGNhY2hlLi4uc28gaXQgaXMgbWlnaHRiZSBhbiB1cGRhdGUuLlxuICAgICAgICAgICAgICAgICAgICBuZXdEYXRhID0gdXBkYXRlUmVjb3JkKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAgICAgbmV3RGF0YSA9IGFkZFJlY29yZChyZWNvcmQpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBpZiAobmV3RGF0YSkge1xuICAgICAgICAgICAgICAgICAgICBuZXdEYXRhQXJyYXkucHVzaChuZXdEYXRhKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIHNEcy5yZWFkeSA9IHRydWU7XG4gICAgICAgICAgICBpZiAoaXNTaW5nbGUpIHtcbiAgICAgICAgICAgICAgICBzeW5jTGlzdGVuZXIubm90aWZ5KCdyZWFkeScsIGdldERhdGEoKSk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHN5bmNMaXN0ZW5lci5ub3RpZnkoJ3JlYWR5JywgZ2V0RGF0YSgpLCBuZXdEYXRhQXJyYXkpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqIEFsdGhvdWdoIG1vc3QgY2FzZXMgYXJlIGhhbmRsZWQgdXNpbmcgb25SZWFkeSwgdGhpcyB0ZWxscyB5b3UgdGhlIGN1cnJlbnQgZGF0YSBzdGF0ZS5cbiAgICAgICAgICogXG4gICAgICAgICAqIEByZXR1cm5zIGlmIHRydWUgaXMgYSBzeW5jIGhhcyBiZWVuIHByb2Nlc3NlZCBvdGhlcndpc2UgZmFsc2UgaWYgdGhlIGRhdGEgaXMgbm90IHJlYWR5LlxuICAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gaXNSZWFkeSgpIHtcbiAgICAgICAgICAgIHJldHVybiB0aGlzLnJlYWR5O1xuICAgICAgICB9XG4gICAgICAgIC8qKlxuICAgICAgICAgKiBcbiAgICAgICAgICogcmV0dXJucyBhIGZ1bmN0aW9uIHRvIHJlbW92ZSB0aGUgbGlzdGVuZXIuXG4gICAgICAgICAqL1xuICAgICAgICBmdW5jdGlvbiBvbkFkZChjYWxsYmFjaykge1xuICAgICAgICAgICAgcmV0dXJuIHN5bmNMaXN0ZW5lci5vbignYWRkJywgY2FsbGJhY2spO1xuICAgICAgICB9XG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqIFxuICAgICAgICAgKiByZXR1cm5zIGEgZnVuY3Rpb24gdG8gcmVtb3ZlIHRoZSBsaXN0ZW5lci5cbiAgICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIG9uVXBkYXRlKGNhbGxiYWNrKSB7XG4gICAgICAgICAgICByZXR1cm4gc3luY0xpc3RlbmVyLm9uKCd1cGRhdGUnLCBjYWxsYmFjayk7XG4gICAgICAgIH1cblxuICAgICAgICAvKipcbiAgICAgICAgICogXG4gICAgICAgICAqIHJldHVybnMgYSBmdW5jdGlvbiB0byByZW1vdmUgdGhlIGxpc3RlbmVyLlxuICAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gb25SZW1vdmUoY2FsbGJhY2spIHtcbiAgICAgICAgICAgIHJldHVybiBzeW5jTGlzdGVuZXIub24oJ3JlbW92ZScsIGNhbGxiYWNrKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiBcbiAgICAgICAgICogcmV0dXJucyBhIGZ1bmN0aW9uIHRvIHJlbW92ZSB0aGUgbGlzdGVuZXIuXG4gICAgICAgICAqL1xuICAgICAgICBmdW5jdGlvbiBvblJlYWR5KGNhbGxiYWNrKSB7XG4gICAgICAgICAgICByZXR1cm4gc3luY0xpc3RlbmVyLm9uKCdyZWFkeScsIGNhbGxiYWNrKTtcbiAgICAgICAgfVxuXG5cbiAgICAgICAgZnVuY3Rpb24gYWRkUmVjb3JkKHJlY29yZCkge1xuICAgICAgICAgICAgY29uc29sZS5kZWJ1ZygnU3luYyAtPiBJbnNlcnRlZCBOZXcgcmVjb3JkICMnICsgcmVjb3JkLmlkICsgJyBmb3Igc3Vic2NyaXB0aW9uIHRvICcgKyBwdWJsaWNhdGlvbik7Ly8gSlNPTi5zdHJpbmdpZnkocmVjb3JkKSk7XG4gICAgICAgICAgICBnZXRSZXZpc2lvbihyZWNvcmQpOyAvLyBqdXN0IG1ha2Ugc3VyZSB3ZSBjYW4gZ2V0IGEgcmV2aXNpb24gYmVmb3JlIHdlIGhhbmRsZSB0aGlzIHJlY29yZFxuICAgICAgICAgICAgdXBkYXRlRGF0YVN0b3JhZ2UoZm9ybWF0UmVjb3JkID8gZm9ybWF0UmVjb3JkKHJlY29yZCkgOiByZWNvcmQpO1xuICAgICAgICAgICAgc3luY0xpc3RlbmVyLm5vdGlmeSgnYWRkJywgcmVjb3JkKTtcbiAgICAgICAgICAgIHJldHVybiByZWNvcmQ7XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiB1cGRhdGVSZWNvcmQocmVjb3JkKSB7XG4gICAgICAgICAgICB2YXIgcHJldmlvdXMgPSByZWNvcmRTdGF0ZXNbcmVjb3JkLmlkXTtcbiAgICAgICAgICAgIGlmIChnZXRSZXZpc2lvbihyZWNvcmQpIDw9IGdldFJldmlzaW9uKHByZXZpb3VzKSkge1xuICAgICAgICAgICAgICAgIHJldHVybiBudWxsO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgY29uc29sZS5kZWJ1ZygnU3luYyAtPiBVcGRhdGVkIHJlY29yZCAjJyArIHJlY29yZC5pZCArICcgZm9yIHN1YnNjcmlwdGlvbiB0byAnICsgcHVibGljYXRpb24pOy8vIEpTT04uc3RyaW5naWZ5KHJlY29yZCkpO1xuICAgICAgICAgICAgdXBkYXRlRGF0YVN0b3JhZ2UoZm9ybWF0UmVjb3JkID8gZm9ybWF0UmVjb3JkKHJlY29yZCkgOiByZWNvcmQpO1xuICAgICAgICAgICAgc3luY0xpc3RlbmVyLm5vdGlmeSgndXBkYXRlJywgcmVjb3JkKTtcbiAgICAgICAgICAgIHJldHVybiByZWNvcmQ7XG4gICAgICAgIH1cblxuXG4gICAgICAgIGZ1bmN0aW9uIHJlbW92ZVJlY29yZChyZWNvcmQpIHtcbiAgICAgICAgICAgIHZhciBwcmV2aW91cyA9IHJlY29yZFN0YXRlc1tyZWNvcmQuaWRdO1xuICAgICAgICAgICAgaWYgKCFwcmV2aW91cyB8fCBnZXRSZXZpc2lvbihyZWNvcmQpID4gZ2V0UmV2aXNpb24ocHJldmlvdXMpKSB7XG4gICAgICAgICAgICAgICAgY29uc29sZS5kZWJ1ZygnU3luYyAtPiBSZW1vdmVkICMnICsgcmVjb3JkLmlkICsgJyBmb3Igc3Vic2NyaXB0aW9uIHRvICcgKyBwdWJsaWNhdGlvbik7XG4gICAgICAgICAgICAgICAgLy8gV2UgY291bGQgaGF2ZSBmb3IgdGhlIHNhbWUgcmVjb3JkIGNvbnNlY3V0aXZlbHkgZmV0Y2hpbmcgaW4gdGhpcyBvcmRlcjpcbiAgICAgICAgICAgICAgICAvLyBkZWxldGUgaWQ6NCwgcmV2IDEwLCB0aGVuIGFkZCBpZDo0LCByZXYgOS4uLi4gYnkga2VlcGluZyB0cmFjayBvZiB3aGF0IHdhcyBkZWxldGVkLCB3ZSB3aWxsIG5vdCBhZGQgdGhlIHJlY29yZCBzaW5jZSBpdCB3YXMgZGVsZXRlZCB3aXRoIGEgbW9zdCByZWNlbnQgdGltZXN0YW1wLlxuICAgICAgICAgICAgICAgIHJlY29yZC5yZW1vdmVkID0gdHJ1ZTsgLy8gU28gd2Ugb25seSBmbGFnIGFzIHJlbW92ZWQsIGxhdGVyIG9uIHRoZSBnYXJiYWdlIGNvbGxlY3RvciB3aWxsIGdldCByaWQgb2YgaXQuICAgICAgICAgXG4gICAgICAgICAgICAgICAgdXBkYXRlRGF0YVN0b3JhZ2UocmVjb3JkKTtcbiAgICAgICAgICAgICAgICAvLyBpZiB0aGVyZSBpcyBubyBwcmV2aW91cyByZWNvcmQgd2UgZG8gbm90IG5lZWQgdG8gcmVtb3ZlZCBhbnkgdGhpbmcgZnJvbSBvdXIgc3RvcmFnZS4gICAgIFxuICAgICAgICAgICAgICAgIGlmIChwcmV2aW91cykge1xuICAgICAgICAgICAgICAgICAgICBzeW5jTGlzdGVuZXIubm90aWZ5KCdyZW1vdmUnLCByZWNvcmQpO1xuICAgICAgICAgICAgICAgICAgICBkaXNwb3NlKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgICAgIGZ1bmN0aW9uIGRpc3Bvc2UocmVjb3JkKSB7XG4gICAgICAgICAgICAkc3luY0dhcmJhZ2VDb2xsZWN0b3IuZGlzcG9zZShmdW5jdGlvbiBjb2xsZWN0KCkge1xuICAgICAgICAgICAgICAgIHZhciBleGlzdGluZ1JlY29yZCA9IHJlY29yZFN0YXRlc1tyZWNvcmQuaWRdO1xuICAgICAgICAgICAgICAgIGlmIChleGlzdGluZ1JlY29yZCAmJiByZWNvcmQucmV2aXNpb24gPj0gZXhpc3RpbmdSZWNvcmQucmV2aXNpb25cbiAgICAgICAgICAgICAgICApIHtcbiAgICAgICAgICAgICAgICAgICAgLy9jb25zb2xlLmRlYnVnKCdDb2xsZWN0IE5vdzonICsgSlNPTi5zdHJpbmdpZnkocmVjb3JkKSk7XG4gICAgICAgICAgICAgICAgICAgIGRlbGV0ZSByZWNvcmRTdGF0ZXNbcmVjb3JkLmlkXTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIGlzRXhpc3RpbmdTdGF0ZUZvcihyZWNvcmRJZCkge1xuICAgICAgICAgICAgcmV0dXJuICEhcmVjb3JkU3RhdGVzW3JlY29yZElkXTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIHVwZGF0ZVN5bmNlZE9iamVjdChyZWNvcmQpIHtcbiAgICAgICAgICAgIHJlY29yZFN0YXRlc1tyZWNvcmQuaWRdID0gcmVjb3JkO1xuICAgICAgICAgICAgY2xlYXJPYmplY3QoY2FjaGUpO1xuICAgICAgICAgICAgaWYgKCFyZWNvcmQucmVtb3ZlKSB7XG4gICAgICAgICAgICAgICAgYW5ndWxhci5leHRlbmQoY2FjaGUsIHJlY29yZCk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiB1cGRhdGVTeW5jZWRBcnJheShyZWNvcmQpIHtcbiAgICAgICAgICAgIHZhciBleGlzdGluZyA9IHJlY29yZFN0YXRlc1tyZWNvcmQuaWRdO1xuICAgICAgICAgICAgaWYgKCFleGlzdGluZykge1xuICAgICAgICAgICAgICAgIC8vIGFkZCBuZXcgaW5zdGFuY2VcbiAgICAgICAgICAgICAgICByZWNvcmRTdGF0ZXNbcmVjb3JkLmlkXSA9IHJlY29yZDtcbiAgICAgICAgICAgICAgICBpZiAoIXJlY29yZC5yZW1vdmVkKSB7XG4gICAgICAgICAgICAgICAgICAgIGNhY2hlLnB1c2gocmVjb3JkKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIC8vIHVwZGF0ZSB0aGUgaW5zdGFuY2VcbiAgICAgICAgICAgICAgICBjbGVhck9iamVjdChleGlzdGluZyk7XG4gICAgICAgICAgICAgICAgYW5ndWxhci5leHRlbmQoZXhpc3RpbmcsIHJlY29yZCk7XG4gICAgICAgICAgICAgICAgaWYgKHJlY29yZC5yZW1vdmVkKSB7XG4gICAgICAgICAgICAgICAgICAgIGNhY2hlLnNwbGljZShjYWNoZS5pbmRleE9mKGV4aXN0aW5nKSwgMSk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gY2xlYXJPYmplY3Qob2JqZWN0KSB7XG4gICAgICAgICAgICBPYmplY3Qua2V5cyhvYmplY3QpLmZvckVhY2goZnVuY3Rpb24gKGtleSkgeyBkZWxldGUgb2JqZWN0W2tleV07IH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gZ2V0UmV2aXNpb24ocmVjb3JkKSB7XG4gICAgICAgICAgICAvLyB3aGF0IHJlc2VydmVkIGZpZWxkIGRvIHdlIHVzZSBhcyB0aW1lc3RhbXBcbiAgICAgICAgICAgIGlmIChhbmd1bGFyLmlzRGVmaW5lZChyZWNvcmQucmV2aXNpb24pKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlY29yZC5yZXZpc2lvbjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChhbmd1bGFyLmlzRGVmaW5lZChyZWNvcmQudGltZXN0YW1wKSkge1xuICAgICAgICAgICAgICAgIHJldHVybiByZWNvcmQudGltZXN0YW1wO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdTeW5jIHJlcXVpcmVzIGEgcmV2aXNpb24gb3IgdGltZXN0YW1wIHByb3BlcnR5IGluIHJlY2VpdmVkICcgKyAob2JqZWN0Q2xhc3MgPyAnb2JqZWN0IFsnICsgb2JqZWN0Q2xhc3MubmFtZSArICddJyA6ICdyZWNvcmQnKSk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiB0aGlzIG9iamVjdCBcbiAgICAgKi9cbiAgICBmdW5jdGlvbiBTeW5jTGlzdGVuZXIoKSB7XG4gICAgICAgIHZhciBldmVudHMgPSB7fTtcbiAgICAgICAgdmFyIGNvdW50ID0gMDtcblxuICAgICAgICB0aGlzLm5vdGlmeSA9IG5vdGlmeTtcbiAgICAgICAgdGhpcy5vbiA9IG9uO1xuXG4gICAgICAgIGZ1bmN0aW9uIG5vdGlmeShldmVudCwgZGF0YTEsIGRhdGEyKSB7XG4gICAgICAgICAgICB2YXIgbGlzdGVuZXJzID0gZXZlbnRzW2V2ZW50XTtcbiAgICAgICAgICAgIGlmIChsaXN0ZW5lcnMpIHtcbiAgICAgICAgICAgICAgICBfLmZvckVhY2gobGlzdGVuZXJzLCBmdW5jdGlvbiAoY2FsbGJhY2ssIGlkKSB7XG4gICAgICAgICAgICAgICAgICAgIGNhbGxiYWNrKGRhdGExLCBkYXRhMik7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICAvKipcbiAgICAgICAgICogQHJldHVybnMgaGFuZGxlciB0byB1bnJlZ2lzdGVyIGxpc3RlbmVyXG4gICAgICAgICAqL1xuICAgICAgICBmdW5jdGlvbiBvbihldmVudCwgY2FsbGJhY2spIHtcbiAgICAgICAgICAgIHZhciBsaXN0ZW5lcnMgPSBldmVudHNbZXZlbnRdO1xuICAgICAgICAgICAgaWYgKCFsaXN0ZW5lcnMpIHtcbiAgICAgICAgICAgICAgICBsaXN0ZW5lcnMgPSBldmVudHNbZXZlbnRdID0ge307XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICB2YXIgaWQgPSBjb3VudCsrO1xuICAgICAgICAgICAgbGlzdGVuZXJzW2lkKytdID0gY2FsbGJhY2s7XG4gICAgICAgICAgICByZXR1cm4gZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgIGRlbGV0ZSBsaXN0ZW5lcnNbaWRdO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuICAgIGZ1bmN0aW9uIGdldENvbnNvbGUoKSB7XG4gICAgICAgIC8vIHRvIGhlbHAgd2l0aCBkZWJ1Z2dpbmcgZm9yIG5vdyB1bnRpbCB3ZSBvcHQgZm9yIGEgbmljZSBsb2dnZXIuIEluIHByb2R1Y3Rpb24sIGxvZyBhbmQgZGVidWcgc2hvdWxkIGF1dG9tYXRpY2FsbHkgYmUgcmVtb3ZlZCBieSB0aGUgYnVpbGQgZnJvbSB0aGUgY29kZS4uLi4gVE9ETzpuZWVkIHRvIGNoZWNrIG91dCB0aGUgcHJvZHVjdGlvbiBjb2RlXG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBsb2c6IGZ1bmN0aW9uIChtc2cpIHtcbiAgICAgICAgICAgICAgICB3aW5kb3cuY29uc29sZS5kZWJ1ZygnU1lOQyhpbmZvKTogJyArIG1zZyk7XG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgZGVidWc6IGZ1bmN0aW9uIChtc2cpIHtcbiAgICAgICAgICAgICAgICAvLyAgd2luZG93LmNvbnNvbGUuZGVidWcoJ1NZTkMoZGVidWcpOiAnICsgbXNnKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfTtcbiAgICB9XG59O1xufSgpKTtcbiJdfQ==
