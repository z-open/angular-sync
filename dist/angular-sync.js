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
        merge: merge,
        clearObject: clearObject
    }

    function merge1(destination, source) {
        clearObject(destination);
        angular.extend(destination, source);
    }

    /** merge an object with an other. Merge also inner objects and objects in array. 
     * Reference to the original objects are maintained in the destination object.
     * Only content is updated.
     */
    function merge(destination, source) {
        if (!destination) {
            return source;// _.assign({}, source);;
        }
        // create new object containing only the properties of source merge with destination
        var object = {};
        for (var property in source) {
            if (_.isArray(source[property])) {
                object[property] = mergeArray(destination[property], source[property]);
            } else if (_.isFunction(source[property])) {
                object[property] = source[property];
            } else if (_.isObject(source[property])) {
                object[property] = merge(destination[property], source[property]);
            } else {
                object[property] = source[property];
            }
        }

        clearObject(destination);
        _.assign(destination, object);

        return destination;
    }

    function mergeArray(destination, source) {
        if (!destination) {
            return source;
        }
        var array = [];
        source.forEach(function (item) {
            // object in array must have an id otherwise we can't maintain the instance reference
            if (!_.isArray(item) && _.isObject(item)) {
                if (!angular.isDefined(item.id)) {
                    throw new Error('objects in array must have an id otherwise we can\'t maintain the instance reference. ' + JSON.stringify(item));
                }
                array.push(merge(_.find(destination, { id: item.id }), item));
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
sync.$inject = ["$rootScope", "$q", "$socketio", "$syncGarbageCollector", "$syncMerge"];
angular
    .module('sync')
    .factory('$sync', sync);

function sync($rootScope, $q, $socketio, $syncGarbageCollector, $syncMerge) {
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

            if (!record.remove) {
                $syncMerge.merge(cache, record);
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
                $syncMerge.merge(existing, record);
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

//# sourceMappingURL=data:application/json;charset=utf8;base64,eyJ2ZXJzaW9uIjozLCJzb3VyY2VzIjpbImFwcC1paWZlLmpzIl0sIm5hbWVzIjpbXSwibWFwcGluZ3MiOiJBQUFBLENBQUEsV0FBQTtBQUNBOztBQUVBO0tBQ0EsT0FBQSxRQUFBLENBQUE7S0FDQSw2QkFBQSxTQUFBLGtCQUFBO1FBQ0Esa0JBQUEsU0FBQTs7OztBQUlBLENBQUEsV0FBQTtBQUNBOztBQUVBO0tBQ0EsT0FBQTtLQUNBLFFBQUEseUJBQUE7Ozs7Ozs7Ozs7QUFVQSxTQUFBLHVCQUFBO0lBQ0EsSUFBQSxRQUFBO0lBQ0EsSUFBQSxVQUFBO0lBQ0EsSUFBQSxZQUFBOztJQUVBLElBQUEsVUFBQTtRQUNBLFlBQUE7UUFDQSxZQUFBO1FBQ0EsU0FBQTtRQUNBLFVBQUE7UUFDQSxLQUFBO1FBQ0EsY0FBQTs7O0lBR0EsT0FBQTs7OztJQUlBLFNBQUEsV0FBQSxPQUFBO1FBQ0EsVUFBQTs7O0lBR0EsU0FBQSxhQUFBO1FBQ0EsT0FBQTs7O0lBR0EsU0FBQSxlQUFBO1FBQ0EsT0FBQSxNQUFBOzs7SUFHQSxTQUFBLFFBQUEsU0FBQTtRQUNBLE1BQUEsS0FBQTtZQUNBLFdBQUEsS0FBQTtZQUNBLFNBQUE7O1FBRUEsSUFBQSxDQUFBLFdBQUE7WUFDQSxRQUFBOzs7O0lBSUEsU0FBQSxXQUFBO1FBQ0EsSUFBQSxDQUFBLFNBQUE7WUFDQSxRQUFBO1lBQ0E7O1FBRUEsWUFBQTtRQUNBLFdBQUEsWUFBQTtZQUNBLFFBQUE7WUFDQSxJQUFBLE1BQUEsU0FBQSxHQUFBO2dCQUNBO21CQUNBO2dCQUNBLFlBQUE7O1dBRUEsVUFBQTs7O0lBR0EsU0FBQSxNQUFBO1FBQ0EsSUFBQSxVQUFBLEtBQUEsUUFBQSxVQUFBO1FBQ0EsT0FBQSxNQUFBLFNBQUEsS0FBQSxNQUFBLEdBQUEsYUFBQSxTQUFBO1lBQ0EsTUFBQSxRQUFBOzs7Ozs7QUFNQSxDQUFBLFdBQUE7QUFDQTs7QUFFQTtLQUNBLE9BQUE7S0FDQSxRQUFBLGNBQUE7O0FBRUEsU0FBQSxZQUFBOztJQUVBLE9BQUE7UUFDQSxPQUFBO1FBQ0EsYUFBQTs7O0lBR0EsU0FBQSxPQUFBLGFBQUEsUUFBQTtRQUNBLFlBQUE7UUFDQSxRQUFBLE9BQUEsYUFBQTs7Ozs7OztJQU9BLFNBQUEsTUFBQSxhQUFBLFFBQUE7UUFDQSxJQUFBLENBQUEsYUFBQTtZQUNBLE9BQUE7OztRQUdBLElBQUEsU0FBQTtRQUNBLEtBQUEsSUFBQSxZQUFBLFFBQUE7WUFDQSxJQUFBLEVBQUEsUUFBQSxPQUFBLFlBQUE7Z0JBQ0EsT0FBQSxZQUFBLFdBQUEsWUFBQSxXQUFBLE9BQUE7bUJBQ0EsSUFBQSxFQUFBLFdBQUEsT0FBQSxZQUFBO2dCQUNBLE9BQUEsWUFBQSxPQUFBO21CQUNBLElBQUEsRUFBQSxTQUFBLE9BQUEsWUFBQTtnQkFDQSxPQUFBLFlBQUEsTUFBQSxZQUFBLFdBQUEsT0FBQTttQkFDQTtnQkFDQSxPQUFBLFlBQUEsT0FBQTs7OztRQUlBLFlBQUE7UUFDQSxFQUFBLE9BQUEsYUFBQTs7UUFFQSxPQUFBOzs7SUFHQSxTQUFBLFdBQUEsYUFBQSxRQUFBO1FBQ0EsSUFBQSxDQUFBLGFBQUE7WUFDQSxPQUFBOztRQUVBLElBQUEsUUFBQTtRQUNBLE9BQUEsUUFBQSxVQUFBLE1BQUE7O1lBRUEsSUFBQSxDQUFBLEVBQUEsUUFBQSxTQUFBLEVBQUEsU0FBQSxPQUFBO2dCQUNBLElBQUEsQ0FBQSxRQUFBLFVBQUEsS0FBQSxLQUFBO29CQUNBLE1BQUEsSUFBQSxNQUFBLDJGQUFBLEtBQUEsVUFBQTs7Z0JBRUEsTUFBQSxLQUFBLE1BQUEsRUFBQSxLQUFBLGFBQUEsRUFBQSxJQUFBLEtBQUEsT0FBQTttQkFDQTtnQkFDQSxNQUFBLEtBQUE7Ozs7UUFJQSxZQUFBLFNBQUE7UUFDQSxNQUFBLFVBQUEsS0FBQSxNQUFBLGFBQUE7O1FBRUEsT0FBQTs7O0lBR0EsU0FBQSxZQUFBLFFBQUE7UUFDQSxPQUFBLEtBQUEsUUFBQSxRQUFBLFVBQUEsS0FBQSxFQUFBLE9BQUEsT0FBQTs7Q0FFQTs7O0FBR0EsQ0FBQSxXQUFBO0FBQ0E7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7Ozs7OztBQXVC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LE1BQUEsUUFBQSxXQUFBOzs7Ozs7Ozs7UUFTQSxTQUFBLFlBQUEsUUFBQTs7WUFFQSxJQUFBLFFBQUEsVUFBQSxPQUFBLFdBQUE7Z0JBQ0EsT0FBQSxPQUFBOztZQUVBLElBQUEsUUFBQSxVQUFBLE9BQUEsWUFBQTtnQkFDQSxPQUFBLE9BQUE7O1lBRUEsTUFBQSxJQUFBLE1BQUEsaUVBQUEsY0FBQSxhQUFBLFlBQUEsT0FBQSxNQUFBOzs7Ozs7O0lBT0EsU0FBQSxlQUFBO1FBQ0EsSUFBQSxTQUFBO1FBQ0EsSUFBQSxRQUFBOztRQUVBLEtBQUEsU0FBQTtRQUNBLEtBQUEsS0FBQTs7UUFFQSxTQUFBLE9BQUEsT0FBQSxPQUFBLE9BQUE7WUFDQSxJQUFBLFlBQUEsT0FBQTtZQUNBLElBQUEsV0FBQTtnQkFDQSxFQUFBLFFBQUEsV0FBQSxVQUFBLFVBQUEsSUFBQTtvQkFDQSxTQUFBLE9BQUE7Ozs7Ozs7O1FBUUEsU0FBQSxHQUFBLE9BQUEsVUFBQTtZQUNBLElBQUEsWUFBQSxPQUFBO1lBQ0EsSUFBQSxDQUFBLFdBQUE7Z0JBQ0EsWUFBQSxPQUFBLFNBQUE7O1lBRUEsSUFBQSxLQUFBO1lBQ0EsVUFBQSxRQUFBO1lBQ0EsT0FBQSxZQUFBO2dCQUNBLE9BQUEsVUFBQTs7OztJQUlBLFNBQUEsYUFBQTs7UUFFQSxPQUFBO1lBQ0EsS0FBQSxVQUFBLEtBQUE7Z0JBQ0EsT0FBQSxRQUFBLE1BQUEsaUJBQUE7O1lBRUEsT0FBQSxVQUFBLEtBQUE7Ozs7O0NBS0E7O0FBRUEiLCJmaWxlIjoiYW5ndWxhci1zeW5jLmpzIiwic291cmNlc0NvbnRlbnQiOlsiKGZ1bmN0aW9uKCkge1xuXCJ1c2Ugc3RyaWN0XCI7XG5cbmFuZ3VsYXJcbiAgICAubW9kdWxlKCdzeW5jJywgWydzb2NrZXRpby1hdXRoJ10pXG4gICAgLmNvbmZpZyhmdW5jdGlvbigkc29ja2V0aW9Qcm92aWRlcil7XG4gICAgICAgICRzb2NrZXRpb1Byb3ZpZGVyLnNldERlYnVnKHRydWUpO1xuICAgIH0pO1xufSgpKTtcblxuKGZ1bmN0aW9uKCkge1xuXCJ1c2Ugc3RyaWN0XCI7XG5cbmFuZ3VsYXJcbiAgICAubW9kdWxlKCdzeW5jJylcbiAgICAuZmFjdG9yeSgnJHN5bmNHYXJiYWdlQ29sbGVjdG9yJywgc3luY0dhcmJhZ2VDb2xsZWN0b3IpO1xuXG4vKipcbiAqIHNhZmVseSByZW1vdmUgZGVsZXRlZCByZWNvcmQvb2JqZWN0IGZyb20gbWVtb3J5IGFmdGVyIHRoZSBzeW5jIHByb2Nlc3MgZGlzcG9zZWQgdGhlbS5cbiAqIFxuICogVE9ETzogU2Vjb25kcyBzaG91bGQgcmVmbGVjdCB0aGUgbWF4IHRpbWUgIHRoYXQgc3luYyBjYWNoZSBpcyB2YWxpZCAobmV0d29yayBsb3NzIHdvdWxkIGZvcmNlIGEgcmVzeW5jKSwgd2hpY2ggc2hvdWxkIG1hdGNoIG1heERpc2Nvbm5lY3Rpb25UaW1lQmVmb3JlRHJvcHBpbmdTdWJzY3JpcHRpb24gb24gdGhlIHNlcnZlciBzaWRlLlxuICogXG4gKiBOb3RlOlxuICogcmVtb3ZlZCByZWNvcmQgc2hvdWxkIGJlIGRlbGV0ZWQgZnJvbSB0aGUgc3luYyBpbnRlcm5hbCBjYWNoZSBhZnRlciBhIHdoaWxlIHNvIHRoYXQgdGhleSBkbyBub3Qgc3RheSBpbiB0aGUgbWVtb3J5LiBUaGV5IGNhbm5vdCBiZSByZW1vdmVkIHRvbyBlYXJseSBhcyBhbiBvbGRlciB2ZXJzaW9uL3N0YW1wIG9mIHRoZSByZWNvcmQgY291bGQgYmUgcmVjZWl2ZWQgYWZ0ZXIgaXRzIHJlbW92YWwuLi53aGljaCB3b3VsZCByZS1hZGQgdG8gY2FjaGUuLi5kdWUgYXN5bmNocm9ub3VzIHByb2Nlc3NpbmcuLi5cbiAqL1xuZnVuY3Rpb24gc3luY0dhcmJhZ2VDb2xsZWN0b3IoKSB7XG4gICAgdmFyIGl0ZW1zID0gW107XG4gICAgdmFyIHNlY29uZHMgPSAyO1xuICAgIHZhciBzY2hlZHVsZWQgPSBmYWxzZTtcblxuICAgIHZhciBzZXJ2aWNlID0ge1xuICAgICAgICBzZXRTZWNvbmRzOiBzZXRTZWNvbmRzLFxuICAgICAgICBnZXRTZWNvbmRzOiBnZXRTZWNvbmRzLFxuICAgICAgICBkaXNwb3NlOiBkaXNwb3NlLFxuICAgICAgICBzY2hlZHVsZTogc2NoZWR1bGUsXG4gICAgICAgIHJ1bjogcnVuLFxuICAgICAgICBnZXRJdGVtQ291bnQ6IGdldEl0ZW1Db3VudFxuICAgIH07XG5cbiAgICByZXR1cm4gc2VydmljZTtcblxuICAgIC8vLy8vLy8vLy9cblxuICAgIGZ1bmN0aW9uIHNldFNlY29uZHModmFsdWUpIHtcbiAgICAgICAgc2Vjb25kcyA9IHZhbHVlO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIGdldFNlY29uZHMoKSB7XG4gICAgICAgIHJldHVybiBzZWNvbmRzO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIGdldEl0ZW1Db3VudCgpIHtcbiAgICAgICAgcmV0dXJuIGl0ZW1zLmxlbmd0aDtcbiAgICB9XG5cbiAgICBmdW5jdGlvbiBkaXNwb3NlKGNvbGxlY3QpIHtcbiAgICAgICAgaXRlbXMucHVzaCh7XG4gICAgICAgICAgICB0aW1lc3RhbXA6IERhdGUubm93KCksXG4gICAgICAgICAgICBjb2xsZWN0OiBjb2xsZWN0XG4gICAgICAgIH0pO1xuICAgICAgICBpZiAoIXNjaGVkdWxlZCkge1xuICAgICAgICAgICAgc2VydmljZS5zY2hlZHVsZSgpO1xuICAgICAgICB9XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gc2NoZWR1bGUoKSB7XG4gICAgICAgIGlmICghc2Vjb25kcykge1xuICAgICAgICAgICAgc2VydmljZS5ydW4oKTtcbiAgICAgICAgICAgIHJldHVybjtcbiAgICAgICAgfVxuICAgICAgICBzY2hlZHVsZWQgPSB0cnVlO1xuICAgICAgICBzZXRUaW1lb3V0KGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIHNlcnZpY2UucnVuKCk7XG4gICAgICAgICAgICBpZiAoaXRlbXMubGVuZ3RoID4gMCkge1xuICAgICAgICAgICAgICAgIHNjaGVkdWxlKCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHNjaGVkdWxlZCA9IGZhbHNlO1xuICAgICAgICAgICAgfVxuICAgICAgICB9LCBzZWNvbmRzICogMTAwMCk7XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gcnVuKCkge1xuICAgICAgICB2YXIgdGltZW91dCA9IERhdGUubm93KCkgLSBzZWNvbmRzICogMTAwMDtcbiAgICAgICAgd2hpbGUgKGl0ZW1zLmxlbmd0aCA+IDAgJiYgaXRlbXNbMF0udGltZXN0YW1wIDw9IHRpbWVvdXQpIHtcbiAgICAgICAgICAgIGl0ZW1zLnNoaWZ0KCkuY29sbGVjdCgpO1xuICAgICAgICB9XG4gICAgfVxufVxufSgpKTtcblxuKGZ1bmN0aW9uKCkge1xuXCJ1c2Ugc3RyaWN0XCI7XG5cbmFuZ3VsYXJcbiAgICAubW9kdWxlKCdzeW5jJylcbiAgICAuZmFjdG9yeSgnJHN5bmNNZXJnZScsIHN5bmNNZXJnZSk7XG5cbmZ1bmN0aW9uIHN5bmNNZXJnZSgpIHtcblxuICAgIHJldHVybiB7XG4gICAgICAgIG1lcmdlOiBtZXJnZSxcbiAgICAgICAgY2xlYXJPYmplY3Q6IGNsZWFyT2JqZWN0XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gbWVyZ2UxKGRlc3RpbmF0aW9uLCBzb3VyY2UpIHtcbiAgICAgICAgY2xlYXJPYmplY3QoZGVzdGluYXRpb24pO1xuICAgICAgICBhbmd1bGFyLmV4dGVuZChkZXN0aW5hdGlvbiwgc291cmNlKTtcbiAgICB9XG5cbiAgICAvKiogbWVyZ2UgYW4gb2JqZWN0IHdpdGggYW4gb3RoZXIuIE1lcmdlIGFsc28gaW5uZXIgb2JqZWN0cyBhbmQgb2JqZWN0cyBpbiBhcnJheS4gXG4gICAgICogUmVmZXJlbmNlIHRvIHRoZSBvcmlnaW5hbCBvYmplY3RzIGFyZSBtYWludGFpbmVkIGluIHRoZSBkZXN0aW5hdGlvbiBvYmplY3QuXG4gICAgICogT25seSBjb250ZW50IGlzIHVwZGF0ZWQuXG4gICAgICovXG4gICAgZnVuY3Rpb24gbWVyZ2UoZGVzdGluYXRpb24sIHNvdXJjZSkge1xuICAgICAgICBpZiAoIWRlc3RpbmF0aW9uKSB7XG4gICAgICAgICAgICByZXR1cm4gc291cmNlOy8vIF8uYXNzaWduKHt9LCBzb3VyY2UpOztcbiAgICAgICAgfVxuICAgICAgICAvLyBjcmVhdGUgbmV3IG9iamVjdCBjb250YWluaW5nIG9ubHkgdGhlIHByb3BlcnRpZXMgb2Ygc291cmNlIG1lcmdlIHdpdGggZGVzdGluYXRpb25cbiAgICAgICAgdmFyIG9iamVjdCA9IHt9O1xuICAgICAgICBmb3IgKHZhciBwcm9wZXJ0eSBpbiBzb3VyY2UpIHtcbiAgICAgICAgICAgIGlmIChfLmlzQXJyYXkoc291cmNlW3Byb3BlcnR5XSkpIHtcbiAgICAgICAgICAgICAgICBvYmplY3RbcHJvcGVydHldID0gbWVyZ2VBcnJheShkZXN0aW5hdGlvbltwcm9wZXJ0eV0sIHNvdXJjZVtwcm9wZXJ0eV0pO1xuICAgICAgICAgICAgfSBlbHNlIGlmIChfLmlzRnVuY3Rpb24oc291cmNlW3Byb3BlcnR5XSkpIHtcbiAgICAgICAgICAgICAgICBvYmplY3RbcHJvcGVydHldID0gc291cmNlW3Byb3BlcnR5XTtcbiAgICAgICAgICAgIH0gZWxzZSBpZiAoXy5pc09iamVjdChzb3VyY2VbcHJvcGVydHldKSkge1xuICAgICAgICAgICAgICAgIG9iamVjdFtwcm9wZXJ0eV0gPSBtZXJnZShkZXN0aW5hdGlvbltwcm9wZXJ0eV0sIHNvdXJjZVtwcm9wZXJ0eV0pO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBvYmplY3RbcHJvcGVydHldID0gc291cmNlW3Byb3BlcnR5XTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIGNsZWFyT2JqZWN0KGRlc3RpbmF0aW9uKTtcbiAgICAgICAgXy5hc3NpZ24oZGVzdGluYXRpb24sIG9iamVjdCk7XG5cbiAgICAgICAgcmV0dXJuIGRlc3RpbmF0aW9uO1xuICAgIH1cblxuICAgIGZ1bmN0aW9uIG1lcmdlQXJyYXkoZGVzdGluYXRpb24sIHNvdXJjZSkge1xuICAgICAgICBpZiAoIWRlc3RpbmF0aW9uKSB7XG4gICAgICAgICAgICByZXR1cm4gc291cmNlO1xuICAgICAgICB9XG4gICAgICAgIHZhciBhcnJheSA9IFtdO1xuICAgICAgICBzb3VyY2UuZm9yRWFjaChmdW5jdGlvbiAoaXRlbSkge1xuICAgICAgICAgICAgLy8gb2JqZWN0IGluIGFycmF5IG11c3QgaGF2ZSBhbiBpZCBvdGhlcndpc2Ugd2UgY2FuJ3QgbWFpbnRhaW4gdGhlIGluc3RhbmNlIHJlZmVyZW5jZVxuICAgICAgICAgICAgaWYgKCFfLmlzQXJyYXkoaXRlbSkgJiYgXy5pc09iamVjdChpdGVtKSkge1xuICAgICAgICAgICAgICAgIGlmICghYW5ndWxhci5pc0RlZmluZWQoaXRlbS5pZCkpIHtcbiAgICAgICAgICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdvYmplY3RzIGluIGFycmF5IG11c3QgaGF2ZSBhbiBpZCBvdGhlcndpc2Ugd2UgY2FuXFwndCBtYWludGFpbiB0aGUgaW5zdGFuY2UgcmVmZXJlbmNlLiAnICsgSlNPTi5zdHJpbmdpZnkoaXRlbSkpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICBhcnJheS5wdXNoKG1lcmdlKF8uZmluZChkZXN0aW5hdGlvbiwgeyBpZDogaXRlbS5pZCB9KSwgaXRlbSkpO1xuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICBhcnJheS5wdXNoKGl0ZW0pO1xuICAgICAgICAgICAgfVxuICAgICAgICB9KTtcblxuICAgICAgICBkZXN0aW5hdGlvbi5sZW5ndGggPSAwO1xuICAgICAgICBBcnJheS5wcm90b3R5cGUucHVzaC5hcHBseShkZXN0aW5hdGlvbiwgYXJyYXkpO1xuICAgICAgICAvL2FuZ3VsYXIuY29weShkZXN0aW5hdGlvbiwgYXJyYXkpO1xuICAgICAgICByZXR1cm4gZGVzdGluYXRpb247XG4gICAgfVxuXG4gICAgZnVuY3Rpb24gY2xlYXJPYmplY3Qob2JqZWN0KSB7XG4gICAgICAgIE9iamVjdC5rZXlzKG9iamVjdCkuZm9yRWFjaChmdW5jdGlvbiAoa2V5KSB7IGRlbGV0ZSBvYmplY3Rba2V5XTsgfSk7XG4gICAgfVxufTtcbn0oKSk7XG5cbihmdW5jdGlvbigpIHtcblwidXNlIHN0cmljdFwiO1xuXG4vKipcbiAqIFxuICogU2VydmljZSB0aGF0IGFsbG93cyBhbiBhcnJheSBvZiBkYXRhIHJlbWFpbiBpbiBzeW5jIHdpdGggYmFja2VuZC5cbiAqIFxuICogXG4gKiBleDpcbiAqIHdoZW4gdGhlcmUgaXMgYSBub3RpZmljYXRpb24sIG5vdGljYXRpb25TZXJ2aWNlIG5vdGlmaWVzIHRoYXQgdGhlcmUgaXMgc29tZXRoaW5nIG5ldy4uLnRoZW4gdGhlIGRhdGFzZXQgZ2V0IHRoZSBkYXRhIGFuZCBub3RpZmllcyBhbGwgaXRzIGNhbGxiYWNrLlxuICogXG4gKiBOT1RFOiBcbiAqICBcbiAqIFxuICogUHJlLVJlcXVpc3RlOlxuICogLS0tLS0tLS0tLS0tLVxuICogU3luYyBkb2VzIG5vdCB3b3JrIGlmIG9iamVjdHMgZG8gbm90IGhhdmUgQk9USCBpZCBhbmQgcmV2aXNpb24gZmllbGQhISEhXG4gKiBcbiAqIFdoZW4gdGhlIGJhY2tlbmQgd3JpdGVzIGFueSBkYXRhIHRvIHRoZSBkYiB0aGF0IGFyZSBzdXBwb3NlZCB0byBiZSBzeW5jcm9uaXplZDpcbiAqIEl0IG11c3QgbWFrZSBzdXJlIGVhY2ggYWRkLCB1cGRhdGUsIHJlbW92YWwgb2YgcmVjb3JkIGlzIHRpbWVzdGFtcGVkLlxuICogSXQgbXVzdCBub3RpZnkgdGhlIGRhdGFzdHJlYW0gKHdpdGggbm90aWZ5Q2hhbmdlIG9yIG5vdGlmeVJlbW92YWwpIHdpdGggc29tZSBwYXJhbXMgc28gdGhhdCBiYWNrZW5kIGtub3dzIHRoYXQgaXQgaGFzIHRvIHB1c2ggYmFjayB0aGUgZGF0YSBiYWNrIHRvIHRoZSBzdWJzY3JpYmVycyAoZXg6IHRoZSB0YXNrQ3JlYXRpb24gd291bGQgbm90aWZ5IHdpdGggaXRzIHBsYW5JZClcbiogXG4gKiBcbiAqL1xuYW5ndWxhclxuICAgIC5tb2R1bGUoJ3N5bmMnKVxuICAgIC5mYWN0b3J5KCckc3luYycsIHN5bmMpO1xuXG5mdW5jdGlvbiBzeW5jKCRyb290U2NvcGUsICRxLCAkc29ja2V0aW8sICRzeW5jR2FyYmFnZUNvbGxlY3RvciwgJHN5bmNNZXJnZSkge1xuICAgIHZhciBwdWJsaWNhdGlvbkxpc3RlbmVycyA9IHt9LFxuICAgICAgICBwdWJsaWNhdGlvbkxpc3RlbmVyQ291bnQgPSAwO1xuICAgIHZhciBHUkFDRV9QRVJJT0RfSU5fU0VDT05EUyA9IDg7XG4gICAgdmFyIFNZTkNfVkVSU0lPTiA9ICcxLjEnO1xuICAgIHZhciBjb25zb2xlID0gZ2V0Q29uc29sZSgpO1xuXG4gICAgbGlzdGVuVG9TeW5jTm90aWZpY2F0aW9uKCk7XG5cbiAgICB2YXIgc2VydmljZSA9IHtcbiAgICAgICAgc3Vic2NyaWJlOiBzdWJzY3JpYmUsXG4gICAgICAgIHJlc29sdmVTdWJzY3JpcHRpb246IHJlc29sdmVTdWJzY3JpcHRpb24sXG4gICAgICAgIGdldEdyYWNlUGVyaW9kOiBnZXRHcmFjZVBlcmlvZFxuICAgIH07XG5cbiAgICByZXR1cm4gc2VydmljZTtcblxuICAgIC8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vXG4gICAgLyoqXG4gICAgICogc3Vic2NyaWJlIHRvIHB1YmxpY2F0aW9uIGFuZCByZXR1cm5zIHRoZSBzdWJzY3JpcHRpb24gd2hlbiBkYXRhIGlzIGF2YWlsYWJsZS4gXG4gICAgICogQHBhcmFtIHB1YmxpY2F0aW9uIG5hbWUuIG9uIHRoZSBzZXJ2ZXIgc2lkZSwgYSBwdWJsaWNhdGlvbiBzaGFsbCBleGlzdC4gZXg6IG1hZ2F6aW5lcy5zeW5jXG4gICAgICogQHBhcmFtIHBhcmFtcyAgIHRoZSBwYXJhbXMgb2JqZWN0IHBhc3NlZCB0byB0aGUgc3Vic2NyaXB0aW9uLCBleDoge21hZ2F6aW5lSWQ6J2VudHJlcHJlbmV1cid9KVxuICAgICAqIEBwYXJhbSBvYmplY3RDbGFzcyBhbiBpbnN0YW5jZSBvZiB0aGlzIGNsYXNzIHdpbGwgYmUgY3JlYXRlZCBmb3IgZWFjaCByZWNvcmQgcmVjZWl2ZWQuXG4gICAgICogcmV0dXJucyBhIHByb21pc2UgcmV0dXJuaW5nIHRoZSBzdWJzY3JpcHRpb24gd2hlbiB0aGUgZGF0YSBpcyBzeW5jZWRcbiAgICAgKiBvciByZWplY3RzIGlmIHRoZSBpbml0aWFsIHN5bmMgZmFpbHMgdG8gY29tcGxldGUgaW4gYSBsaW1pdGVkIGFtb3VudCBvZiB0aW1lLiBcbiAgICAgKiBcbiAgICAgKiB0byBnZXQgdGhlIGRhdGEgZnJvbSB0aGUgZGF0YVNldCwganVzdCBkYXRhU2V0LmdldERhdGEoKVxuICAgICAqL1xuICAgIGZ1bmN0aW9uIHJlc29sdmVTdWJzY3JpcHRpb24ocHVibGljYXRpb25OYW1lLCBwYXJhbXMsIG9iamVjdENsYXNzKSB7XG4gICAgICAgIHZhciBkZWZlcnJlZCA9ICRxLmRlZmVyKCk7XG4gICAgICAgIHZhciBzRHMgPSBzdWJzY3JpYmUocHVibGljYXRpb25OYW1lKS5zZXRPYmplY3RDbGFzcyhvYmplY3RDbGFzcyk7XG5cbiAgICAgICAgLy8gZ2l2ZSBhIGxpdHRsZSB0aW1lIGZvciBzdWJzY3JpcHRpb24gdG8gZmV0Y2ggdGhlIGRhdGEuLi5vdGhlcndpc2UgZ2l2ZSB1cCBzbyB0aGF0IHdlIGRvbid0IGdldCBzdHVjayBpbiBhIHJlc29sdmUgd2FpdGluZyBmb3JldmVyLlxuICAgICAgICB2YXIgZ3JhY2VQZXJpb2QgPSBzZXRUaW1lb3V0KGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgIGlmICghc0RzLnJlYWR5KSB7XG4gICAgICAgICAgICAgICAgc0RzLmRlc3Ryb3koKTtcbiAgICAgICAgICAgICAgICBjb25zb2xlLmxvZygnQXR0ZW1wdCB0byBzdWJzY3JpYmUgdG8gcHVibGljYXRpb24gJyArIHB1YmxpY2F0aW9uTmFtZSArICcgZmFpbGVkJyk7XG4gICAgICAgICAgICAgICAgZGVmZXJyZWQucmVqZWN0KCdTWU5DX1RJTUVPVVQnKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfSwgR1JBQ0VfUEVSSU9EX0lOX1NFQ09ORFMgKiAxMDAwKTtcblxuICAgICAgICBzRHMuc2V0UGFyYW1ldGVycyhwYXJhbXMpXG4gICAgICAgICAgICAud2FpdEZvckRhdGFSZWFkeSgpXG4gICAgICAgICAgICAudGhlbihmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgY2xlYXJUaW1lb3V0KGdyYWNlUGVyaW9kKTtcbiAgICAgICAgICAgICAgICBkZWZlcnJlZC5yZXNvbHZlKHNEcyk7XG4gICAgICAgICAgICB9KS5jYXRjaChmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgY2xlYXJUaW1lb3V0KGdyYWNlUGVyaW9kKTtcbiAgICAgICAgICAgICAgICBzRHMuZGVzdHJveSgpO1xuICAgICAgICAgICAgICAgIGRlZmVycmVkLnJlamVjdCgnRmFpbGVkIHRvIHN1YnNjcmliZSB0byBwdWJsaWNhdGlvbiAnICsgcHVibGljYXRpb25OYW1lICsgJyBmYWlsZWQnKTtcbiAgICAgICAgICAgIH0pO1xuICAgICAgICByZXR1cm4gZGVmZXJyZWQucHJvbWlzZTtcbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiBcbiAgICAgKiBmb3IgdGVzdCBwdXJwb3NlcywgcmV0dXJucyB0aGUgdGltZSByZXNvbHZlU3Vic2NyaXB0aW9uIGJlZm9yZSBpdCB0aW1lcyBvdXQuXG4gICAgICovXG4gICAgZnVuY3Rpb24gZ2V0R3JhY2VQZXJpb2QoKSB7XG4gICAgICAgIHJldHVybiBHUkFDRV9QRVJJT0RfSU5fU0VDT05EUztcbiAgICB9XG4gICAgLyoqXG4gICAgICogc3Vic2NyaWJlIHRvIHB1YmxpY2F0aW9uLiBJdCB3aWxsIG5vdCBzeW5jIHVudGlsIHlvdSBzZXQgdGhlIHBhcmFtcy5cbiAgICAgKiBcbiAgICAgKiBAcGFyYW0gcHVibGljYXRpb24gbmFtZS4gb24gdGhlIHNlcnZlciBzaWRlLCBhIHB1YmxpY2F0aW9uIHNoYWxsIGV4aXN0LiBleDogbWFnYXppbmVzLnN5bmNcbiAgICAgKiBAcGFyYW0gcGFyYW1zICAgdGhlIHBhcmFtcyBvYmplY3QgcGFzc2VkIHRvIHRoZSBzdWJzY3JpcHRpb24sIGV4OiB7bWFnYXppbmVJZDonZW50cmVwcmVuZXVyJ30pXG4gICAgICogcmV0dXJucyBzdWJzY3JpcHRpb25cbiAgICAgKiBcbiAgICAgKi9cbiAgICBmdW5jdGlvbiBzdWJzY3JpYmUocHVibGljYXRpb25OYW1lLCBzY29wZSkge1xuICAgICAgICByZXR1cm4gbmV3IFN1YnNjcmlwdGlvbihwdWJsaWNhdGlvbk5hbWUsIHNjb3BlKTtcbiAgICB9XG5cblxuXG4gICAgLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy9cbiAgICAvLyBIRUxQRVJTXG5cbiAgICAvLyBldmVyeSBzeW5jIG5vdGlmaWNhdGlvbiBjb21lcyB0aHJ1IHRoZSBzYW1lIGV2ZW50IHRoZW4gaXQgaXMgZGlzcGF0Y2hlcyB0byB0aGUgdGFyZ2V0ZWQgc3Vic2NyaXB0aW9ucy5cbiAgICBmdW5jdGlvbiBsaXN0ZW5Ub1N5bmNOb3RpZmljYXRpb24oKSB7XG4gICAgICAgICRzb2NrZXRpby5vbignU1lOQ19OT1cnLCBmdW5jdGlvbiAoc3ViTm90aWZpY2F0aW9uLCBmbikge1xuICAgICAgICAgICAgY29uc29sZS5sb2coJ1N5bmNpbmcgd2l0aCBzdWJzY3JpcHRpb24gW25hbWU6JyArIHN1Yk5vdGlmaWNhdGlvbi5uYW1lICsgJywgaWQ6JyArIHN1Yk5vdGlmaWNhdGlvbi5zdWJzY3JpcHRpb25JZCArICcgLCBwYXJhbXM6JyArIEpTT04uc3RyaW5naWZ5KHN1Yk5vdGlmaWNhdGlvbi5wYXJhbXMpICsgJ10uIFJlY29yZHM6JyArIHN1Yk5vdGlmaWNhdGlvbi5yZWNvcmRzLmxlbmd0aCArICdbJyArIChzdWJOb3RpZmljYXRpb24uZGlmZiA/ICdEaWZmJyA6ICdBbGwnKSArICddJyk7XG4gICAgICAgICAgICB2YXIgbGlzdGVuZXJzID0gcHVibGljYXRpb25MaXN0ZW5lcnNbc3ViTm90aWZpY2F0aW9uLm5hbWVdO1xuICAgICAgICAgICAgaWYgKGxpc3RlbmVycykge1xuICAgICAgICAgICAgICAgIGZvciAodmFyIGxpc3RlbmVyIGluIGxpc3RlbmVycykge1xuICAgICAgICAgICAgICAgICAgICBsaXN0ZW5lcnNbbGlzdGVuZXJdKHN1Yk5vdGlmaWNhdGlvbik7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICAgICAgZm4oJ1NZTkNFRCcpOyAvLyBsZXQga25vdyB0aGUgYmFja2VuZCB0aGUgY2xpZW50IHdhcyBhYmxlIHRvIHN5bmMuXG4gICAgICAgIH0pO1xuICAgIH07XG5cblxuICAgIC8vIHRoaXMgYWxsb3dzIGEgZGF0YXNldCB0byBsaXN0ZW4gdG8gYW55IFNZTkNfTk9XIGV2ZW50Li5hbmQgaWYgdGhlIG5vdGlmaWNhdGlvbiBpcyBhYm91dCBpdHMgZGF0YS5cbiAgICBmdW5jdGlvbiBhZGRQdWJsaWNhdGlvbkxpc3RlbmVyKHN0cmVhbU5hbWUsIGNhbGxiYWNrKSB7XG4gICAgICAgIHZhciB1aWQgPSBwdWJsaWNhdGlvbkxpc3RlbmVyQ291bnQrKztcbiAgICAgICAgdmFyIGxpc3RlbmVycyA9IHB1YmxpY2F0aW9uTGlzdGVuZXJzW3N0cmVhbU5hbWVdO1xuICAgICAgICBpZiAoIWxpc3RlbmVycykge1xuICAgICAgICAgICAgcHVibGljYXRpb25MaXN0ZW5lcnNbc3RyZWFtTmFtZV0gPSBsaXN0ZW5lcnMgPSB7fTtcbiAgICAgICAgfVxuICAgICAgICBsaXN0ZW5lcnNbdWlkXSA9IGNhbGxiYWNrO1xuXG4gICAgICAgIHJldHVybiBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICBkZWxldGUgbGlzdGVuZXJzW3VpZF07XG4gICAgICAgIH1cbiAgICB9XG4gICAgLy8gLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tXG4gICAgLy8gU3Vic2NyaXB0aW9uIG9iamVjdFxuICAgIC8vIC0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLS0tLVxuICAgIC8qKlxuICAgICAqIGEgc3Vic2NyaXB0aW9uIHN5bmNocm9uaXplcyB3aXRoIHRoZSBiYWNrZW5kIGZvciBhbnkgYmFja2VuZCBkYXRhIGNoYW5nZSBhbmQgbWFrZXMgdGhhdCBkYXRhIGF2YWlsYWJsZSB0byBhIGNvbnRyb2xsZXIuXG4gICAgICogXG4gICAgICogIFdoZW4gY2xpZW50IHN1YnNjcmliZXMgdG8gYW4gc3luY3Jvbml6ZWQgYXBpLCBhbnkgZGF0YSBjaGFuZ2UgdGhhdCBpbXBhY3RzIHRoZSBhcGkgcmVzdWx0IFdJTEwgYmUgUFVTSGVkIHRvIHRoZSBjbGllbnQuXG4gICAgICogSWYgdGhlIGNsaWVudCBkb2VzIE5PVCBzdWJzY3JpYmUgb3Igc3RvcCBzdWJzY3JpYmUsIGl0IHdpbGwgbm8gbG9uZ2VyIHJlY2VpdmUgdGhlIFBVU0guIFxuICAgICAqICAgIFxuICAgICAqIGlmIHRoZSBjb25uZWN0aW9uIGlzIGxvc3QgZm9yIGEgc2hvcnQgdGltZSAoZHVyYXRpb24gZGVmaW5lZCBvbiBzZXJ2ZXItc2lkZSksIHRoZSBzZXJ2ZXIgcXVldWVzIHRoZSBjaGFuZ2VzIGlmIGFueS4gXG4gICAgICogV2hlbiB0aGUgY29ubmVjdGlvbiByZXR1cm5zLCB0aGUgbWlzc2luZyBkYXRhIGF1dG9tYXRpY2FsbHkgIHdpbGwgYmUgUFVTSGVkIHRvIHRoZSBzdWJzY3JpYmluZyBjbGllbnQuXG4gICAgICogaWYgdGhlIGNvbm5lY3Rpb24gaXMgbG9zdCBmb3IgYSBsb25nIHRpbWUgKGR1cmF0aW9uIGRlZmluZWQgb24gdGhlIHNlcnZlciksIHRoZSBzZXJ2ZXIgd2lsbCBkZXN0cm95IHRoZSBzdWJzY3JpcHRpb24uIFRvIHNpbXBsaWZ5LCB0aGUgY2xpZW50IHdpbGwgcmVzdWJzY3JpYmUgYXQgaXRzIHJlY29ubmVjdGlvbiBhbmQgZ2V0IGFsbCBkYXRhLlxuICAgICAqIFxuICAgICAqIHN1YnNjcmlwdGlvbiBvYmplY3QgcHJvdmlkZXMgMyBjYWxsYmFja3MgKGFkZCx1cGRhdGUsIGRlbCkgd2hpY2ggYXJlIGNhbGxlZCBkdXJpbmcgc3luY2hyb25pemF0aW9uLlxuICAgICAqICAgICAgXG4gICAgICogU2NvcGUgd2lsbCBhbGxvdyB0aGUgc3Vic2NyaXB0aW9uIHN0b3Agc3luY2hyb25pemluZyBhbmQgY2FuY2VsIHJlZ2lzdHJhdGlvbiB3aGVuIGl0IGlzIGRlc3Ryb3llZC4gXG4gICAgICogIFxuICAgICAqIENvbnN0cnVjdG9yOlxuICAgICAqIFxuICAgICAqIEBwYXJhbSBwdWJsaWNhdGlvbiwgdGhlIHB1YmxpY2F0aW9uIG11c3QgZXhpc3Qgb24gdGhlIHNlcnZlciBzaWRlXG4gICAgICogQHBhcmFtIHNjb3BlLCBieSBkZWZhdWx0ICRyb290U2NvcGUsIGJ1dCBjYW4gYmUgbW9kaWZpZWQgbGF0ZXIgb24gd2l0aCBhdHRhY2ggbWV0aG9kLlxuICAgICAqL1xuXG4gICAgZnVuY3Rpb24gU3Vic2NyaXB0aW9uKHB1YmxpY2F0aW9uLCBzY29wZSkge1xuICAgICAgICB2YXIgdGltZXN0YW1wRmllbGQsIGlzU3luY2luZ09uID0gZmFsc2UsIGlzU2luZ2xlLCB1cGRhdGVEYXRhU3RvcmFnZSwgY2FjaGUsIGlzSW5pdGlhbFB1c2hDb21wbGV0ZWQsIGRlZmVycmVkSW5pdGlhbGl6YXRpb247XG4gICAgICAgIHZhciBvblJlYWR5T2ZmLCBmb3JtYXRSZWNvcmQ7XG4gICAgICAgIHZhciByZWNvbm5lY3RPZmYsIHB1YmxpY2F0aW9uTGlzdGVuZXJPZmYsIGRlc3Ryb3lPZmY7XG4gICAgICAgIHZhciBvYmplY3RDbGFzcztcbiAgICAgICAgdmFyIHN1YnNjcmlwdGlvbklkO1xuXG4gICAgICAgIHZhciBzRHMgPSB0aGlzO1xuICAgICAgICB2YXIgc3ViUGFyYW1zID0ge307XG4gICAgICAgIHZhciByZWNvcmRTdGF0ZXMgPSB7fTtcbiAgICAgICAgdmFyIGlubmVyU2NvcGU7Ly89ICRyb290U2NvcGUuJG5ldyh0cnVlKTtcbiAgICAgICAgdmFyIHN5bmNMaXN0ZW5lciA9IG5ldyBTeW5jTGlzdGVuZXIoKTtcblxuXG4gICAgICAgIHRoaXMucmVhZHkgPSBmYWxzZTtcbiAgICAgICAgdGhpcy5zeW5jT24gPSBzeW5jT247XG4gICAgICAgIHRoaXMuc3luY09mZiA9IHN5bmNPZmY7XG4gICAgICAgIHRoaXMuc2V0T25SZWFkeSA9IHNldE9uUmVhZHk7XG5cbiAgICAgICAgdGhpcy5vblJlYWR5ID0gb25SZWFkeTtcbiAgICAgICAgdGhpcy5vblVwZGF0ZSA9IG9uVXBkYXRlO1xuICAgICAgICB0aGlzLm9uQWRkID0gb25BZGQ7XG4gICAgICAgIHRoaXMub25SZW1vdmUgPSBvblJlbW92ZTtcblxuICAgICAgICB0aGlzLmdldERhdGEgPSBnZXREYXRhO1xuICAgICAgICB0aGlzLnNldFBhcmFtZXRlcnMgPSBzZXRQYXJhbWV0ZXJzO1xuXG4gICAgICAgIHRoaXMud2FpdEZvckRhdGFSZWFkeSA9IHdhaXRGb3JEYXRhUmVhZHk7XG4gICAgICAgIHRoaXMud2FpdEZvclN1YnNjcmlwdGlvblJlYWR5ID0gd2FpdEZvclN1YnNjcmlwdGlvblJlYWR5O1xuXG4gICAgICAgIHRoaXMuc2V0Rm9yY2UgPSBzZXRGb3JjZTtcbiAgICAgICAgdGhpcy5pc1N5bmNpbmcgPSBpc1N5bmNpbmc7XG4gICAgICAgIHRoaXMuaXNSZWFkeSA9IGlzUmVhZHk7XG5cbiAgICAgICAgdGhpcy5zZXRTaW5nbGUgPSBzZXRTaW5nbGU7XG5cbiAgICAgICAgdGhpcy5zZXRPYmplY3RDbGFzcyA9IHNldE9iamVjdENsYXNzO1xuICAgICAgICB0aGlzLmdldE9iamVjdENsYXNzID0gZ2V0T2JqZWN0Q2xhc3M7XG5cbiAgICAgICAgdGhpcy5hdHRhY2ggPSBhdHRhY2g7XG4gICAgICAgIHRoaXMuZGVzdHJveSA9IGRlc3Ryb3k7XG5cbiAgICAgICAgdGhpcy5pc0V4aXN0aW5nU3RhdGVGb3IgPSBpc0V4aXN0aW5nU3RhdGVGb3I7IC8vIGZvciB0ZXN0aW5nIHB1cnBvc2VzXG5cbiAgICAgICAgc2V0U2luZ2xlKGZhbHNlKTtcblxuICAgICAgICAvLyB0aGlzIHdpbGwgbWFrZSBzdXJlIHRoYXQgdGhlIHN1YnNjcmlwdGlvbiBpcyByZWxlYXNlZCBmcm9tIHNlcnZlcnMgaWYgdGhlIGFwcCBjbG9zZXMgKGNsb3NlIGJyb3dzZXIsIHJlZnJlc2guLi4pXG4gICAgICAgIGF0dGFjaChzY29wZSB8fCAkcm9vdFNjb3BlKTtcblxuICAgICAgICAvLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vLy8vXG5cbiAgICAgICAgZnVuY3Rpb24gZGVzdHJveSgpIHtcbiAgICAgICAgICAgIHN5bmNPZmYoKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8qKiB0aGlzIHdpbGwgYmUgY2FsbGVkIHdoZW4gZGF0YSBpcyBhdmFpbGFibGUgXG4gICAgICAgICAqICBpdCBtZWFucyByaWdodCBhZnRlciBlYWNoIHN5bmMhXG4gICAgICAgICAqIFxuICAgICAgICAgKiBcbiAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gc2V0T25SZWFkeShjYWxsYmFjaykge1xuICAgICAgICAgICAgaWYgKG9uUmVhZHlPZmYpIHtcbiAgICAgICAgICAgICAgICBvblJlYWR5T2ZmKCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBvblJlYWR5T2ZmID0gb25SZWFkeShjYWxsYmFjayk7XG4gICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICB9XG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqIGZvcmNlIHJlc3luY2luZyBmcm9tIHNjcmF0Y2ggZXZlbiBpZiB0aGUgcGFyYW1ldGVycyBoYXZlIG5vdCBjaGFuZ2VkXG4gICAgICAgICAqIFxuICAgICAgICAgKiBpZiBvdXRzaWRlIGNvZGUgaGFzIG1vZGlmaWVkIHRoZSBkYXRhIGFuZCB5b3UgbmVlZCB0byByb2xsYmFjaywgeW91IGNvdWxkIGNvbnNpZGVyIGZvcmNpbmcgYSByZWZyZXNoIHdpdGggdGhpcy4gQmV0dGVyIHNvbHV0aW9uIHNob3VsZCBiZSBmb3VuZCB0aGFuIHRoYXQuXG4gICAgICAgICAqIFxuICAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gc2V0Rm9yY2UodmFsdWUpIHtcbiAgICAgICAgICAgIGlmICh2YWx1ZSkge1xuICAgICAgICAgICAgICAgIC8vIHF1aWNrIGhhY2sgdG8gZm9yY2UgdG8gcmVsb2FkLi4ucmVjb2RlIGxhdGVyLlxuICAgICAgICAgICAgICAgIHNEcy5zeW5jT2ZmKCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICB9XG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqIFRoZSBmb2xsb3dpbmcgb2JqZWN0IHdpbGwgYmUgYnVpbHQgdXBvbiBlYWNoIHJlY29yZCByZWNlaXZlZCBmcm9tIHRoZSBiYWNrZW5kXG4gICAgICAgICAqIFxuICAgICAgICAgKiBUaGlzIGNhbm5vdCBiZSBtb2RpZmllZCBhZnRlciB0aGUgc3luYyBoYXMgc3RhcnRlZC5cbiAgICAgICAgICogXG4gICAgICAgICAqIEBwYXJhbSBjbGFzc1ZhbHVlXG4gICAgICAgICAqL1xuICAgICAgICBmdW5jdGlvbiBzZXRPYmplY3RDbGFzcyhjbGFzc1ZhbHVlKSB7XG4gICAgICAgICAgICBpZiAoZGVmZXJyZWRJbml0aWFsaXphdGlvbikge1xuICAgICAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgICAgICB9XG5cbiAgICAgICAgICAgIG9iamVjdENsYXNzID0gY2xhc3NWYWx1ZTtcbiAgICAgICAgICAgIGZvcm1hdFJlY29yZCA9IGZ1bmN0aW9uIChyZWNvcmQpIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gbmV3IG9iamVjdENsYXNzKHJlY29yZCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBzZXRTaW5nbGUoaXNTaW5nbGUpO1xuICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIGdldE9iamVjdENsYXNzKCkge1xuICAgICAgICAgICAgcmV0dXJuIG9iamVjdENsYXNzO1xuICAgICAgICB9XG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqIHRoaXMgZnVuY3Rpb24gc3RhcnRzIHRoZSBzeW5jaW5nLlxuICAgICAgICAgKiBPbmx5IHB1YmxpY2F0aW9uIHB1c2hpbmcgZGF0YSBtYXRjaGluZyBvdXIgZmV0Y2hpbmcgcGFyYW1zIHdpbGwgYmUgcmVjZWl2ZWQuXG4gICAgICAgICAqIFxuICAgICAgICAgKiBleDogZm9yIGEgcHVibGljYXRpb24gbmFtZWQgXCJtYWdhemluZXMuc3luY1wiLCBpZiBmZXRjaGluZyBwYXJhbXMgZXF1YWxsZWQge21hZ2F6aW5OYW1lOidjYXJzJ30sIHRoZSBtYWdhemluZSBjYXJzIGRhdGEgd291bGQgYmUgcmVjZWl2ZWQgYnkgdGhpcyBzdWJzY3JpcHRpb24uXG4gICAgICAgICAqIFxuICAgICAgICAgKiBAcGFyYW0gZmV0Y2hpbmdQYXJhbXNcbiAgICAgICAgICogQHBhcmFtIG9wdGlvbnNcbiAgICAgICAgICogXG4gICAgICAgICAqIEByZXR1cm5zIGEgcHJvbWlzZSB0aGF0IHJlc29sdmVzIHdoZW4gZGF0YSBpcyBhcnJpdmVkLlxuICAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gc2V0UGFyYW1ldGVycyhmZXRjaGluZ1BhcmFtcywgb3B0aW9ucykge1xuICAgICAgICAgICAgaWYgKGlzU3luY2luZ09uICYmIGFuZ3VsYXIuZXF1YWxzKGZldGNoaW5nUGFyYW1zLCBzdWJQYXJhbXMpKSB7XG4gICAgICAgICAgICAgICAgLy8gaWYgdGhlIHBhcmFtcyBoYXZlIG5vdCBjaGFuZ2VkLCBqdXN0IHJldHVybnMgd2l0aCBjdXJyZW50IGRhdGEuXG4gICAgICAgICAgICAgICAgcmV0dXJuIHNEczsgLy8kcS5yZXNvbHZlKGdldERhdGEoKSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBzeW5jT2ZmKCk7XG4gICAgICAgICAgICBpZiAoIWlzU2luZ2xlKSB7XG4gICAgICAgICAgICAgICAgY2FjaGUubGVuZ3RoID0gMDtcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgc3ViUGFyYW1zID0gZmV0Y2hpbmdQYXJhbXMgfHwge307XG4gICAgICAgICAgICBvcHRpb25zID0gb3B0aW9ucyB8fCB7fTtcbiAgICAgICAgICAgIGlmIChhbmd1bGFyLmlzRGVmaW5lZChvcHRpb25zLnNpbmdsZSkpIHtcbiAgICAgICAgICAgICAgICBzZXRTaW5nbGUob3B0aW9ucy5zaW5nbGUpO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgc3luY09uKCk7XG4gICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gd2FpdCBmb3IgdGhlIGluaXRpYWwgZmV0Y2ggdG8gY29tcGxldGUgdGhlbiByZXR1cm5zIHRoaXMgc3Vic2NyaXB0aW9uXG4gICAgICAgIGZ1bmN0aW9uIHdhaXRGb3JTdWJzY3JpcHRpb25SZWFkeSgpIHtcbiAgICAgICAgICAgIHJldHVybiBkZWZlcnJlZEluaXRpYWxpemF0aW9uLnByb21pc2UudGhlbihmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gd2FpdCBmb3IgdGhlIGluaXRpYWwgZmV0Y2ggdG8gY29tcGxldGUgdGhlbiByZXR1cm5zIHRoZSBkYXRhXG4gICAgICAgIGZ1bmN0aW9uIHdhaXRGb3JEYXRhUmVhZHkoKSB7XG4gICAgICAgICAgICByZXR1cm4gZGVmZXJyZWRJbml0aWFsaXphdGlvbi5wcm9taXNlO1xuICAgICAgICB9XG5cbiAgICAgICAgLy8gZG9lcyB0aGUgZGF0YXNldCByZXR1cm5zIG9ubHkgb25lIG9iamVjdD8gbm90IGFuIGFycmF5P1xuICAgICAgICBmdW5jdGlvbiBzZXRTaW5nbGUodmFsdWUpIHtcbiAgICAgICAgICAgIGlmIChkZWZlcnJlZEluaXRpYWxpemF0aW9uKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHNEcztcbiAgICAgICAgICAgIH1cblxuICAgICAgICAgICAgaXNTaW5nbGUgPSB2YWx1ZTtcbiAgICAgICAgICAgIGlmICh2YWx1ZSkge1xuICAgICAgICAgICAgICAgIHVwZGF0ZURhdGFTdG9yYWdlID0gdXBkYXRlU3luY2VkT2JqZWN0O1xuICAgICAgICAgICAgICAgIGNhY2hlID0gb2JqZWN0Q2xhc3MgPyBuZXcgb2JqZWN0Q2xhc3Moe30pIDoge307XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgIHVwZGF0ZURhdGFTdG9yYWdlID0gdXBkYXRlU3luY2VkQXJyYXk7XG4gICAgICAgICAgICAgICAgY2FjaGUgPSBbXTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgIH1cblxuICAgICAgICAvLyByZXR1cm5zIHRoZSBvYmplY3Qgb3IgYXJyYXkgaW4gc3luY1xuICAgICAgICBmdW5jdGlvbiBnZXREYXRhKCkge1xuICAgICAgICAgICAgcmV0dXJuIGNhY2hlO1xuICAgICAgICB9XG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqIHRoZSBkYXRhc2V0IHdpbGwgc3RhcnQgbGlzdGVuaW5nIHRvIHRoZSBkYXRhc3RyZWFtIFxuICAgICAgICAgKiBcbiAgICAgICAgICogTm90ZSBEdXJpbmcgdGhlIHN5bmMsIGl0IHdpbGwgYWxzbyBjYWxsIHRoZSBvcHRpb25hbCBjYWxsYmFja3MgLSBhZnRlciBwcm9jZXNzaW5nIEVBQ0ggcmVjb3JkIHJlY2VpdmVkLlxuICAgICAgICAgKiBcbiAgICAgICAgICogQHJldHVybnMgYSBwcm9taXNlIHRoYXQgd2lsbCBiZSByZXNvbHZlZCB3aGVuIHRoZSBkYXRhIGlzIHJlYWR5LlxuICAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gc3luY09uKCkge1xuICAgICAgICAgICAgaWYgKGlzU3luY2luZ09uKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIGRlZmVycmVkSW5pdGlhbGl6YXRpb24ucHJvbWlzZTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGRlZmVycmVkSW5pdGlhbGl6YXRpb24gPSAkcS5kZWZlcigpO1xuICAgICAgICAgICAgaXNJbml0aWFsUHVzaENvbXBsZXRlZCA9IGZhbHNlO1xuICAgICAgICAgICAgY29uc29sZS5sb2coJ1N5bmMgJyArIHB1YmxpY2F0aW9uICsgJyBvbi4gUGFyYW1zOicgKyBKU09OLnN0cmluZ2lmeShzdWJQYXJhbXMpKTtcbiAgICAgICAgICAgIGlzU3luY2luZ09uID0gdHJ1ZTtcbiAgICAgICAgICAgIHJlZ2lzdGVyU3Vic2NyaXB0aW9uKCk7XG4gICAgICAgICAgICByZWFkeUZvckxpc3RlbmluZygpO1xuICAgICAgICAgICAgcmV0dXJuIGRlZmVycmVkSW5pdGlhbGl6YXRpb24ucHJvbWlzZTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiB0aGUgZGF0YXNldCBpcyBubyBsb25nZXIgbGlzdGVuaW5nIGFuZCB3aWxsIG5vdCBjYWxsIGFueSBjYWxsYmFja1xuICAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gc3luY09mZigpIHtcbiAgICAgICAgICAgIGlmIChkZWZlcnJlZEluaXRpYWxpemF0aW9uKSB7XG4gICAgICAgICAgICAgICAgLy8gaWYgdGhlcmUgaXMgY29kZSB3YWl0aW5nIG9uIHRoaXMgcHJvbWlzZS4uIGV4IChsb2FkIGluIHJlc29sdmUpXG4gICAgICAgICAgICAgICAgZGVmZXJyZWRJbml0aWFsaXphdGlvbi5yZXNvbHZlKGdldERhdGEoKSk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpZiAoaXNTeW5jaW5nT24pIHtcbiAgICAgICAgICAgICAgICB1bnJlZ2lzdGVyU3Vic2NyaXB0aW9uKCk7XG4gICAgICAgICAgICAgICAgaXNTeW5jaW5nT24gPSBmYWxzZTtcblxuICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKCdTeW5jICcgKyBwdWJsaWNhdGlvbiArICcgb2ZmLiBQYXJhbXM6JyArIEpTT04uc3RyaW5naWZ5KHN1YlBhcmFtcykpO1xuICAgICAgICAgICAgICAgIGlmIChwdWJsaWNhdGlvbkxpc3RlbmVyT2ZmKSB7XG4gICAgICAgICAgICAgICAgICAgIHB1YmxpY2F0aW9uTGlzdGVuZXJPZmYoKTtcbiAgICAgICAgICAgICAgICAgICAgcHVibGljYXRpb25MaXN0ZW5lck9mZiA9IG51bGw7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGlmIChyZWNvbm5lY3RPZmYpIHtcbiAgICAgICAgICAgICAgICAgICAgcmVjb25uZWN0T2ZmKCk7XG4gICAgICAgICAgICAgICAgICAgIHJlY29ubmVjdE9mZiA9IG51bGw7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gaXNTeW5jaW5nKCkge1xuICAgICAgICAgICAgcmV0dXJuIGlzU3luY2luZ09uO1xuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gcmVhZHlGb3JMaXN0ZW5pbmcoKSB7XG4gICAgICAgICAgICBpZiAoIXB1YmxpY2F0aW9uTGlzdGVuZXJPZmYpIHtcbiAgICAgICAgICAgICAgICBsaXN0ZW5Gb3JSZWNvbm5lY3Rpb25Ub1Jlc3luYygpO1xuICAgICAgICAgICAgICAgIGxpc3RlblRvUHVibGljYXRpb24oKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiAgQnkgZGVmYXVsdCB0aGUgcm9vdHNjb3BlIGlzIGF0dGFjaGVkIGlmIG5vIHNjb3BlIHdhcyBwcm92aWRlZC4gQnV0IGl0IGlzIHBvc3NpYmxlIHRvIHJlLWF0dGFjaCBpdCB0byBhIGRpZmZlcmVudCBzY29wZS4gaWYgdGhlIHN1YnNjcmlwdGlvbiBkZXBlbmRzIG9uIGEgY29udHJvbGxlci5cbiAgICAgICAgICpcbiAgICAgICAgICogIERvIG5vdCBhdHRhY2ggYWZ0ZXIgaXQgaGFzIHN5bmNlZC5cbiAgICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIGF0dGFjaChuZXdTY29wZSkge1xuICAgICAgICAgICAgaWYgKGRlZmVycmVkSW5pdGlhbGl6YXRpb24pIHtcbiAgICAgICAgICAgICAgICByZXR1cm4gc0RzO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgaWYgKGRlc3Ryb3lPZmYpIHtcbiAgICAgICAgICAgICAgICBkZXN0cm95T2ZmKCk7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBpbm5lclNjb3BlID0gbmV3U2NvcGU7XG4gICAgICAgICAgICBkZXN0cm95T2ZmID0gaW5uZXJTY29wZS4kb24oJyRkZXN0cm95JywgZGVzdHJveSk7XG5cbiAgICAgICAgICAgIHJldHVybiBzRHM7XG4gICAgICAgIH1cblxuICAgICAgICBmdW5jdGlvbiBsaXN0ZW5Gb3JSZWNvbm5lY3Rpb25Ub1Jlc3luYyhsaXN0ZW5Ob3cpIHtcbiAgICAgICAgICAgIC8vIGdpdmUgYSBjaGFuY2UgdG8gY29ubmVjdCBiZWZvcmUgbGlzdGVuaW5nIHRvIHJlY29ubmVjdGlvbi4uLiBAVE9ETyBzaG91bGQgaGF2ZSB1c2VyX3JlY29ubmVjdGVkX2V2ZW50XG4gICAgICAgICAgICBzZXRUaW1lb3V0KGZ1bmN0aW9uICgpIHtcbiAgICAgICAgICAgICAgICByZWNvbm5lY3RPZmYgPSBpbm5lclNjb3BlLiRvbigndXNlcl9jb25uZWN0ZWQnLCBmdW5jdGlvbiAoKSB7XG4gICAgICAgICAgICAgICAgICAgIGNvbnNvbGUuZGVidWcoJ1Jlc3luY2luZyBhZnRlciBuZXR3b3JrIGxvc3MgdG8gJyArIHB1YmxpY2F0aW9uKTtcbiAgICAgICAgICAgICAgICAgICAgLy8gbm90ZSB0aGUgYmFja2VuZCBtaWdodCByZXR1cm4gYSBuZXcgc3Vic2NyaXB0aW9uIGlmIHRoZSBjbGllbnQgdG9vayB0b28gbXVjaCB0aW1lIHRvIHJlY29ubmVjdC5cbiAgICAgICAgICAgICAgICAgICAgcmVnaXN0ZXJTdWJzY3JpcHRpb24oKTtcbiAgICAgICAgICAgICAgICB9KTtcbiAgICAgICAgICAgIH0sIGxpc3Rlbk5vdyA/IDAgOiAyMDAwKTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIHJlZ2lzdGVyU3Vic2NyaXB0aW9uKCkge1xuICAgICAgICAgICAgJHNvY2tldGlvLmZldGNoKCdzeW5jLnN1YnNjcmliZScsIHtcbiAgICAgICAgICAgICAgICB2ZXJzaW9uOiBTWU5DX1ZFUlNJT04sXG4gICAgICAgICAgICAgICAgaWQ6IHN1YnNjcmlwdGlvbklkLCAvLyB0byB0cnkgdG8gcmUtdXNlIGV4aXN0aW5nIHN1YmNyaXB0aW9uXG4gICAgICAgICAgICAgICAgcHVibGljYXRpb246IHB1YmxpY2F0aW9uLFxuICAgICAgICAgICAgICAgIHBhcmFtczogc3ViUGFyYW1zXG4gICAgICAgICAgICB9KS50aGVuKGZ1bmN0aW9uIChzdWJJZCkge1xuICAgICAgICAgICAgICAgIHN1YnNjcmlwdGlvbklkID0gc3ViSWQ7XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIHVucmVnaXN0ZXJTdWJzY3JpcHRpb24oKSB7XG4gICAgICAgICAgICBpZiAoc3Vic2NyaXB0aW9uSWQpIHtcbiAgICAgICAgICAgICAgICAkc29ja2V0aW8uZmV0Y2goJ3N5bmMudW5zdWJzY3JpYmUnLCB7XG4gICAgICAgICAgICAgICAgICAgIHZlcnNpb246IFNZTkNfVkVSU0lPTixcbiAgICAgICAgICAgICAgICAgICAgaWQ6IHN1YnNjcmlwdGlvbklkXG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICAgICAgc3Vic2NyaXB0aW9uSWQgPSBudWxsO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gbGlzdGVuVG9QdWJsaWNhdGlvbigpIHtcbiAgICAgICAgICAgIC8vIGNhbm5vdCBvbmx5IGxpc3RlbiB0byBzdWJzY3JpcHRpb25JZCB5ZXQuLi5iZWNhdXNlIHRoZSByZWdpc3RyYXRpb24gbWlnaHQgaGF2ZSBhbnN3ZXIgcHJvdmlkZWQgaXRzIGlkIHlldC4uLmJ1dCBzdGFydGVkIGJyb2FkY2FzdGluZyBjaGFuZ2VzLi4uQFRPRE8gY2FuIGJlIGltcHJvdmVkLi4uXG4gICAgICAgICAgICBwdWJsaWNhdGlvbkxpc3RlbmVyT2ZmID0gYWRkUHVibGljYXRpb25MaXN0ZW5lcihwdWJsaWNhdGlvbiwgZnVuY3Rpb24gKGJhdGNoKSB7XG4gICAgICAgICAgICAgICAgaWYgKHN1YnNjcmlwdGlvbklkID09PSBiYXRjaC5zdWJzY3JpcHRpb25JZCB8fCAoIXN1YnNjcmlwdGlvbklkICYmIGNoZWNrRGF0YVNldFBhcmFtc0lmTWF0Y2hpbmdCYXRjaFBhcmFtcyhiYXRjaC5wYXJhbXMpKSkge1xuICAgICAgICAgICAgICAgICAgICBpZiAoIWJhdGNoLmRpZmYpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIC8vIENsZWFyIHRoZSBjYWNoZSB0byByZWJ1aWxkIGl0IGlmIGFsbCBkYXRhIHdhcyByZWNlaXZlZC5cbiAgICAgICAgICAgICAgICAgICAgICAgIHJlY29yZFN0YXRlcyA9IHt9O1xuICAgICAgICAgICAgICAgICAgICAgICAgaWYgKCFpc1NpbmdsZSkge1xuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGNhY2hlLmxlbmd0aCA9IDA7XG4gICAgICAgICAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICAgICAgYXBwbHlDaGFuZ2VzKGJhdGNoLnJlY29yZHMpO1xuICAgICAgICAgICAgICAgICAgICBpZiAoIWlzSW5pdGlhbFB1c2hDb21wbGV0ZWQpIHtcbiAgICAgICAgICAgICAgICAgICAgICAgIGlzSW5pdGlhbFB1c2hDb21wbGV0ZWQgPSB0cnVlO1xuICAgICAgICAgICAgICAgICAgICAgICAgZGVmZXJyZWRJbml0aWFsaXphdGlvbi5yZXNvbHZlKGdldERhdGEoKSk7XG4gICAgICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9KTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8qKlxuICAgICAgICAqIGlmIHRoZSBwYXJhbXMgb2YgdGhlIGRhdGFzZXQgbWF0Y2hlcyB0aGUgbm90aWZpY2F0aW9uLCBpdCBtZWFucyB0aGUgZGF0YSBuZWVkcyB0byBiZSBjb2xsZWN0IHRvIHVwZGF0ZSBhcnJheS5cbiAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gY2hlY2tEYXRhU2V0UGFyYW1zSWZNYXRjaGluZ0JhdGNoUGFyYW1zKGJhdGNoUGFyYW1zKSB7XG4gICAgICAgICAgICAvLyBpZiAocGFyYW1zLmxlbmd0aCAhPSBzdHJlYW1QYXJhbXMubGVuZ3RoKSB7XG4gICAgICAgICAgICAvLyAgICAgcmV0dXJuIGZhbHNlO1xuICAgICAgICAgICAgLy8gfVxuICAgICAgICAgICAgaWYgKCFzdWJQYXJhbXMgfHwgT2JqZWN0LmtleXMoc3ViUGFyYW1zKS5sZW5ndGggPT0gMCkge1xuICAgICAgICAgICAgICAgIHJldHVybiB0cnVlXG4gICAgICAgICAgICB9XG4gICAgICAgICAgICB2YXIgbWF0Y2hpbmcgPSB0cnVlO1xuICAgICAgICAgICAgZm9yICh2YXIgcGFyYW0gaW4gYmF0Y2hQYXJhbXMpIHtcbiAgICAgICAgICAgICAgICAvLyBhcmUgb3RoZXIgcGFyYW1zIG1hdGNoaW5nP1xuICAgICAgICAgICAgICAgIC8vIGV4OiB3ZSBtaWdodCBoYXZlIHJlY2VpdmUgYSBub3RpZmljYXRpb24gYWJvdXQgdGFza0lkPTIwIGJ1dCB0aGlzIHN1YnNjcmlwdGlvbiBhcmUgb25seSBpbnRlcmVzdGVkIGFib3V0IHRhc2tJZC0zXG4gICAgICAgICAgICAgICAgaWYgKGJhdGNoUGFyYW1zW3BhcmFtXSAhPT0gc3ViUGFyYW1zW3BhcmFtXSkge1xuICAgICAgICAgICAgICAgICAgICBtYXRjaGluZyA9IGZhbHNlO1xuICAgICAgICAgICAgICAgICAgICBicmVhaztcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICByZXR1cm4gbWF0Y2hpbmc7XG5cbiAgICAgICAgfVxuXG4gICAgICAgIC8vIGZldGNoIGFsbCB0aGUgbWlzc2luZyByZWNvcmRzLCBhbmQgYWN0aXZhdGUgdGhlIGNhbGwgYmFja3MgKGFkZCx1cGRhdGUscmVtb3ZlKSBhY2NvcmRpbmdseSBpZiB0aGVyZSBpcyBzb21ldGhpbmcgdGhhdCBpcyBuZXcgb3Igbm90IGFscmVhZHkgaW4gc3luYy5cbiAgICAgICAgZnVuY3Rpb24gYXBwbHlDaGFuZ2VzKHJlY29yZHMpIHtcbiAgICAgICAgICAgIHZhciBuZXdEYXRhQXJyYXkgPSBbXTtcbiAgICAgICAgICAgIHZhciBuZXdEYXRhO1xuICAgICAgICAgICAgc0RzLnJlYWR5ID0gZmFsc2U7XG4gICAgICAgICAgICByZWNvcmRzLmZvckVhY2goZnVuY3Rpb24gKHJlY29yZCkge1xuICAgICAgICAgICAgICAgIC8vICAgICAgICAgICAgICAgICAgIGNvbnNvbGUubG9nKCdEYXRhc3luYyBbJyArIGRhdGFTdHJlYW1OYW1lICsgJ10gcmVjZWl2ZWQ6JyArSlNPTi5zdHJpbmdpZnkocmVjb3JkKSk7Ly8rIHJlY29yZC5pZCk7XG4gICAgICAgICAgICAgICAgaWYgKHJlY29yZC5yZW1vdmUpIHtcbiAgICAgICAgICAgICAgICAgICAgcmVtb3ZlUmVjb3JkKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgfSBlbHNlIGlmIChyZWNvcmRTdGF0ZXNbcmVjb3JkLmlkXSkge1xuICAgICAgICAgICAgICAgICAgICAvLyBpZiB0aGUgcmVjb3JkIGlzIGFscmVhZHkgcHJlc2VudCBpbiB0aGUgY2FjaGUuLi5zbyBpdCBpcyBtaWdodGJlIGFuIHVwZGF0ZS4uXG4gICAgICAgICAgICAgICAgICAgIG5ld0RhdGEgPSB1cGRhdGVSZWNvcmQocmVjb3JkKTtcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICAgICBuZXdEYXRhID0gYWRkUmVjb3JkKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgICAgIGlmIChuZXdEYXRhKSB7XG4gICAgICAgICAgICAgICAgICAgIG5ld0RhdGFBcnJheS5wdXNoKG5ld0RhdGEpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuICAgICAgICAgICAgc0RzLnJlYWR5ID0gdHJ1ZTtcbiAgICAgICAgICAgIGlmIChpc1NpbmdsZSkge1xuICAgICAgICAgICAgICAgIHN5bmNMaXN0ZW5lci5ub3RpZnkoJ3JlYWR5JywgZ2V0RGF0YSgpKTtcbiAgICAgICAgICAgIH0gZWxzZSB7XG4gICAgICAgICAgICAgICAgc3luY0xpc3RlbmVyLm5vdGlmeSgncmVhZHknLCBnZXREYXRhKCksIG5ld0RhdGFBcnJheSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICAvKipcbiAgICAgICAgICogQWx0aG91Z2ggbW9zdCBjYXNlcyBhcmUgaGFuZGxlZCB1c2luZyBvblJlYWR5LCB0aGlzIHRlbGxzIHlvdSB0aGUgY3VycmVudCBkYXRhIHN0YXRlLlxuICAgICAgICAgKiBcbiAgICAgICAgICogQHJldHVybnMgaWYgdHJ1ZSBpcyBhIHN5bmMgaGFzIGJlZW4gcHJvY2Vzc2VkIG90aGVyd2lzZSBmYWxzZSBpZiB0aGUgZGF0YSBpcyBub3QgcmVhZHkuXG4gICAgICAgICAqL1xuICAgICAgICBmdW5jdGlvbiBpc1JlYWR5KCkge1xuICAgICAgICAgICAgcmV0dXJuIHRoaXMucmVhZHk7XG4gICAgICAgIH1cbiAgICAgICAgLyoqXG4gICAgICAgICAqIFxuICAgICAgICAgKiByZXR1cm5zIGEgZnVuY3Rpb24gdG8gcmVtb3ZlIHRoZSBsaXN0ZW5lci5cbiAgICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIG9uQWRkKGNhbGxiYWNrKSB7XG4gICAgICAgICAgICByZXR1cm4gc3luY0xpc3RlbmVyLm9uKCdhZGQnLCBjYWxsYmFjayk7XG4gICAgICAgIH1cblxuICAgICAgICAvKipcbiAgICAgICAgICogXG4gICAgICAgICAqIHJldHVybnMgYSBmdW5jdGlvbiB0byByZW1vdmUgdGhlIGxpc3RlbmVyLlxuICAgICAgICAgKi9cbiAgICAgICAgZnVuY3Rpb24gb25VcGRhdGUoY2FsbGJhY2spIHtcbiAgICAgICAgICAgIHJldHVybiBzeW5jTGlzdGVuZXIub24oJ3VwZGF0ZScsIGNhbGxiYWNrKTtcbiAgICAgICAgfVxuXG4gICAgICAgIC8qKlxuICAgICAgICAgKiBcbiAgICAgICAgICogcmV0dXJucyBhIGZ1bmN0aW9uIHRvIHJlbW92ZSB0aGUgbGlzdGVuZXIuXG4gICAgICAgICAqL1xuICAgICAgICBmdW5jdGlvbiBvblJlbW92ZShjYWxsYmFjaykge1xuICAgICAgICAgICAgcmV0dXJuIHN5bmNMaXN0ZW5lci5vbigncmVtb3ZlJywgY2FsbGJhY2spO1xuICAgICAgICB9XG5cbiAgICAgICAgLyoqXG4gICAgICAgICAqIFxuICAgICAgICAgKiByZXR1cm5zIGEgZnVuY3Rpb24gdG8gcmVtb3ZlIHRoZSBsaXN0ZW5lci5cbiAgICAgICAgICovXG4gICAgICAgIGZ1bmN0aW9uIG9uUmVhZHkoY2FsbGJhY2spIHtcbiAgICAgICAgICAgIHJldHVybiBzeW5jTGlzdGVuZXIub24oJ3JlYWR5JywgY2FsbGJhY2spO1xuICAgICAgICB9XG5cblxuICAgICAgICBmdW5jdGlvbiBhZGRSZWNvcmQocmVjb3JkKSB7XG4gICAgICAgICAgICBjb25zb2xlLmRlYnVnKCdTeW5jIC0+IEluc2VydGVkIE5ldyByZWNvcmQgIycgKyByZWNvcmQuaWQgKyAnIGZvciBzdWJzY3JpcHRpb24gdG8gJyArIHB1YmxpY2F0aW9uKTsvLyBKU09OLnN0cmluZ2lmeShyZWNvcmQpKTtcbiAgICAgICAgICAgIGdldFJldmlzaW9uKHJlY29yZCk7IC8vIGp1c3QgbWFrZSBzdXJlIHdlIGNhbiBnZXQgYSByZXZpc2lvbiBiZWZvcmUgd2UgaGFuZGxlIHRoaXMgcmVjb3JkXG4gICAgICAgICAgICB1cGRhdGVEYXRhU3RvcmFnZShmb3JtYXRSZWNvcmQgPyBmb3JtYXRSZWNvcmQocmVjb3JkKSA6IHJlY29yZCk7XG4gICAgICAgICAgICBzeW5jTGlzdGVuZXIubm90aWZ5KCdhZGQnLCByZWNvcmQpO1xuICAgICAgICAgICAgcmV0dXJuIHJlY29yZDtcbiAgICAgICAgfVxuXG4gICAgICAgIGZ1bmN0aW9uIHVwZGF0ZVJlY29yZChyZWNvcmQpIHtcbiAgICAgICAgICAgIHZhciBwcmV2aW91cyA9IHJlY29yZFN0YXRlc1tyZWNvcmQuaWRdO1xuICAgICAgICAgICAgaWYgKGdldFJldmlzaW9uKHJlY29yZCkgPD0gZ2V0UmV2aXNpb24ocHJldmlvdXMpKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIG51bGw7XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICBjb25zb2xlLmRlYnVnKCdTeW5jIC0+IFVwZGF0ZWQgcmVjb3JkICMnICsgcmVjb3JkLmlkICsgJyBmb3Igc3Vic2NyaXB0aW9uIHRvICcgKyBwdWJsaWNhdGlvbik7Ly8gSlNPTi5zdHJpbmdpZnkocmVjb3JkKSk7XG4gICAgICAgICAgICB1cGRhdGVEYXRhU3RvcmFnZShmb3JtYXRSZWNvcmQgPyBmb3JtYXRSZWNvcmQocmVjb3JkKSA6IHJlY29yZCk7XG4gICAgICAgICAgICBzeW5jTGlzdGVuZXIubm90aWZ5KCd1cGRhdGUnLCByZWNvcmQpO1xuICAgICAgICAgICAgcmV0dXJuIHJlY29yZDtcbiAgICAgICAgfVxuXG5cbiAgICAgICAgZnVuY3Rpb24gcmVtb3ZlUmVjb3JkKHJlY29yZCkge1xuICAgICAgICAgICAgdmFyIHByZXZpb3VzID0gcmVjb3JkU3RhdGVzW3JlY29yZC5pZF07XG4gICAgICAgICAgICBpZiAoIXByZXZpb3VzIHx8IGdldFJldmlzaW9uKHJlY29yZCkgPiBnZXRSZXZpc2lvbihwcmV2aW91cykpIHtcbiAgICAgICAgICAgICAgICBjb25zb2xlLmRlYnVnKCdTeW5jIC0+IFJlbW92ZWQgIycgKyByZWNvcmQuaWQgKyAnIGZvciBzdWJzY3JpcHRpb24gdG8gJyArIHB1YmxpY2F0aW9uKTtcbiAgICAgICAgICAgICAgICAvLyBXZSBjb3VsZCBoYXZlIGZvciB0aGUgc2FtZSByZWNvcmQgY29uc2VjdXRpdmVseSBmZXRjaGluZyBpbiB0aGlzIG9yZGVyOlxuICAgICAgICAgICAgICAgIC8vIGRlbGV0ZSBpZDo0LCByZXYgMTAsIHRoZW4gYWRkIGlkOjQsIHJldiA5Li4uLiBieSBrZWVwaW5nIHRyYWNrIG9mIHdoYXQgd2FzIGRlbGV0ZWQsIHdlIHdpbGwgbm90IGFkZCB0aGUgcmVjb3JkIHNpbmNlIGl0IHdhcyBkZWxldGVkIHdpdGggYSBtb3N0IHJlY2VudCB0aW1lc3RhbXAuXG4gICAgICAgICAgICAgICAgcmVjb3JkLnJlbW92ZWQgPSB0cnVlOyAvLyBTbyB3ZSBvbmx5IGZsYWcgYXMgcmVtb3ZlZCwgbGF0ZXIgb24gdGhlIGdhcmJhZ2UgY29sbGVjdG9yIHdpbGwgZ2V0IHJpZCBvZiBpdC4gICAgICAgICBcbiAgICAgICAgICAgICAgICB1cGRhdGVEYXRhU3RvcmFnZShyZWNvcmQpO1xuICAgICAgICAgICAgICAgIC8vIGlmIHRoZXJlIGlzIG5vIHByZXZpb3VzIHJlY29yZCB3ZSBkbyBub3QgbmVlZCB0byByZW1vdmVkIGFueSB0aGluZyBmcm9tIG91ciBzdG9yYWdlLiAgICAgXG4gICAgICAgICAgICAgICAgaWYgKHByZXZpb3VzKSB7XG4gICAgICAgICAgICAgICAgICAgIHN5bmNMaXN0ZW5lci5ub3RpZnkoJ3JlbW92ZScsIHJlY29yZCk7XG4gICAgICAgICAgICAgICAgICAgIGRpc3Bvc2UocmVjb3JkKTtcbiAgICAgICAgICAgICAgICB9XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cbiAgICAgICAgZnVuY3Rpb24gZGlzcG9zZShyZWNvcmQpIHtcbiAgICAgICAgICAgICRzeW5jR2FyYmFnZUNvbGxlY3Rvci5kaXNwb3NlKGZ1bmN0aW9uIGNvbGxlY3QoKSB7XG4gICAgICAgICAgICAgICAgdmFyIGV4aXN0aW5nUmVjb3JkID0gcmVjb3JkU3RhdGVzW3JlY29yZC5pZF07XG4gICAgICAgICAgICAgICAgaWYgKGV4aXN0aW5nUmVjb3JkICYmIHJlY29yZC5yZXZpc2lvbiA+PSBleGlzdGluZ1JlY29yZC5yZXZpc2lvblxuICAgICAgICAgICAgICAgICkge1xuICAgICAgICAgICAgICAgICAgICAvL2NvbnNvbGUuZGVidWcoJ0NvbGxlY3QgTm93OicgKyBKU09OLnN0cmluZ2lmeShyZWNvcmQpKTtcbiAgICAgICAgICAgICAgICAgICAgZGVsZXRlIHJlY29yZFN0YXRlc1tyZWNvcmQuaWRdO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH0pO1xuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gaXNFeGlzdGluZ1N0YXRlRm9yKHJlY29yZElkKSB7XG4gICAgICAgICAgICByZXR1cm4gISFyZWNvcmRTdGF0ZXNbcmVjb3JkSWRdO1xuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gdXBkYXRlU3luY2VkT2JqZWN0KHJlY29yZCkge1xuICAgICAgICAgICAgcmVjb3JkU3RhdGVzW3JlY29yZC5pZF0gPSByZWNvcmQ7XG5cbiAgICAgICAgICAgIGlmICghcmVjb3JkLnJlbW92ZSkge1xuICAgICAgICAgICAgICAgICRzeW5jTWVyZ2UubWVyZ2UoY2FjaGUsIHJlY29yZCk7XG4gICAgICAgICAgICB9IGVsc2Uge1xuICAgICAgICAgICAgICAgICRzeW5jTWVyZ2UuY2xlYXJPYmplY3QoY2FjaGUpO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG5cbiAgICAgICAgZnVuY3Rpb24gdXBkYXRlU3luY2VkQXJyYXkocmVjb3JkKSB7XG4gICAgICAgICAgICB2YXIgZXhpc3RpbmcgPSByZWNvcmRTdGF0ZXNbcmVjb3JkLmlkXTtcbiAgICAgICAgICAgIGlmICghZXhpc3RpbmcpIHtcbiAgICAgICAgICAgICAgICAvLyBhZGQgbmV3IGluc3RhbmNlXG4gICAgICAgICAgICAgICAgcmVjb3JkU3RhdGVzW3JlY29yZC5pZF0gPSByZWNvcmQ7XG4gICAgICAgICAgICAgICAgaWYgKCFyZWNvcmQucmVtb3ZlZCkge1xuICAgICAgICAgICAgICAgICAgICBjYWNoZS5wdXNoKHJlY29yZCk7XG4gICAgICAgICAgICAgICAgfVxuICAgICAgICAgICAgfSBlbHNlIHtcbiAgICAgICAgICAgICAgICAkc3luY01lcmdlLm1lcmdlKGV4aXN0aW5nLCByZWNvcmQpO1xuICAgICAgICAgICAgICAgIGlmIChyZWNvcmQucmVtb3ZlZCkge1xuICAgICAgICAgICAgICAgICAgICBjYWNoZS5zcGxpY2UoY2FjaGUuaW5kZXhPZihleGlzdGluZyksIDEpO1xuICAgICAgICAgICAgICAgIH1cbiAgICAgICAgICAgIH1cbiAgICAgICAgfVxuXG5cblxuXG5cbiAgICAgICAgZnVuY3Rpb24gZ2V0UmV2aXNpb24ocmVjb3JkKSB7XG4gICAgICAgICAgICAvLyB3aGF0IHJlc2VydmVkIGZpZWxkIGRvIHdlIHVzZSBhcyB0aW1lc3RhbXBcbiAgICAgICAgICAgIGlmIChhbmd1bGFyLmlzRGVmaW5lZChyZWNvcmQucmV2aXNpb24pKSB7XG4gICAgICAgICAgICAgICAgcmV0dXJuIHJlY29yZC5yZXZpc2lvbjtcbiAgICAgICAgICAgIH1cbiAgICAgICAgICAgIGlmIChhbmd1bGFyLmlzRGVmaW5lZChyZWNvcmQudGltZXN0YW1wKSkge1xuICAgICAgICAgICAgICAgIHJldHVybiByZWNvcmQudGltZXN0YW1wO1xuICAgICAgICAgICAgfVxuICAgICAgICAgICAgdGhyb3cgbmV3IEVycm9yKCdTeW5jIHJlcXVpcmVzIGEgcmV2aXNpb24gb3IgdGltZXN0YW1wIHByb3BlcnR5IGluIHJlY2VpdmVkICcgKyAob2JqZWN0Q2xhc3MgPyAnb2JqZWN0IFsnICsgb2JqZWN0Q2xhc3MubmFtZSArICddJyA6ICdyZWNvcmQnKSk7XG4gICAgICAgIH1cbiAgICB9XG5cbiAgICAvKipcbiAgICAgKiB0aGlzIG9iamVjdCBcbiAgICAgKi9cbiAgICBmdW5jdGlvbiBTeW5jTGlzdGVuZXIoKSB7XG4gICAgICAgIHZhciBldmVudHMgPSB7fTtcbiAgICAgICAgdmFyIGNvdW50ID0gMDtcblxuICAgICAgICB0aGlzLm5vdGlmeSA9IG5vdGlmeTtcbiAgICAgICAgdGhpcy5vbiA9IG9uO1xuXG4gICAgICAgIGZ1bmN0aW9uIG5vdGlmeShldmVudCwgZGF0YTEsIGRhdGEyKSB7XG4gICAgICAgICAgICB2YXIgbGlzdGVuZXJzID0gZXZlbnRzW2V2ZW50XTtcbiAgICAgICAgICAgIGlmIChsaXN0ZW5lcnMpIHtcbiAgICAgICAgICAgICAgICBfLmZvckVhY2gobGlzdGVuZXJzLCBmdW5jdGlvbiAoY2FsbGJhY2ssIGlkKSB7XG4gICAgICAgICAgICAgICAgICAgIGNhbGxiYWNrKGRhdGExLCBkYXRhMik7XG4gICAgICAgICAgICAgICAgfSk7XG4gICAgICAgICAgICB9XG4gICAgICAgIH1cblxuICAgICAgICAvKipcbiAgICAgICAgICogQHJldHVybnMgaGFuZGxlciB0byB1bnJlZ2lzdGVyIGxpc3RlbmVyXG4gICAgICAgICAqL1xuICAgICAgICBmdW5jdGlvbiBvbihldmVudCwgY2FsbGJhY2spIHtcbiAgICAgICAgICAgIHZhciBsaXN0ZW5lcnMgPSBldmVudHNbZXZlbnRdO1xuICAgICAgICAgICAgaWYgKCFsaXN0ZW5lcnMpIHtcbiAgICAgICAgICAgICAgICBsaXN0ZW5lcnMgPSBldmVudHNbZXZlbnRdID0ge307XG4gICAgICAgICAgICB9XG4gICAgICAgICAgICB2YXIgaWQgPSBjb3VudCsrO1xuICAgICAgICAgICAgbGlzdGVuZXJzW2lkKytdID0gY2FsbGJhY2s7XG4gICAgICAgICAgICByZXR1cm4gZnVuY3Rpb24gKCkge1xuICAgICAgICAgICAgICAgIGRlbGV0ZSBsaXN0ZW5lcnNbaWRdO1xuICAgICAgICAgICAgfVxuICAgICAgICB9XG4gICAgfVxuICAgIGZ1bmN0aW9uIGdldENvbnNvbGUoKSB7XG4gICAgICAgIC8vIHRvIGhlbHAgd2l0aCBkZWJ1Z2dpbmcgZm9yIG5vdyB1bnRpbCB3ZSBvcHQgZm9yIGEgbmljZSBsb2dnZXIuIEluIHByb2R1Y3Rpb24sIGxvZyBhbmQgZGVidWcgc2hvdWxkIGF1dG9tYXRpY2FsbHkgYmUgcmVtb3ZlZCBieSB0aGUgYnVpbGQgZnJvbSB0aGUgY29kZS4uLi4gVE9ETzpuZWVkIHRvIGNoZWNrIG91dCB0aGUgcHJvZHVjdGlvbiBjb2RlXG4gICAgICAgIHJldHVybiB7XG4gICAgICAgICAgICBsb2c6IGZ1bmN0aW9uIChtc2cpIHtcbiAgICAgICAgICAgICAgICB3aW5kb3cuY29uc29sZS5kZWJ1ZygnU1lOQyhpbmZvKTogJyArIG1zZyk7XG4gICAgICAgICAgICB9LFxuICAgICAgICAgICAgZGVidWc6IGZ1bmN0aW9uIChtc2cpIHtcbiAgICAgICAgICAgICAgICAvLyAgd2luZG93LmNvbnNvbGUuZGVidWcoJ1NZTkMoZGVidWcpOiAnICsgbXNnKTtcbiAgICAgICAgICAgIH1cbiAgICAgICAgfTtcbiAgICB9XG59O1xufSgpKTtcbiJdfQ==
