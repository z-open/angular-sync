describe('Sync Service: ', function () {
    var $rootScope, $timeout, $q;
    var backend;
    var spec;


    beforeEach(module('sync')); // still depends on commont...until we create a bower/npm

    beforeEach(module(function ($provide, $socketioProvider, $syncProvider) {
        backend = new MockBackend();
        $provide.value('$socketio', new MockSocketio());
        $syncProvider.setDebug(2);
        $socketioProvider.setDebug(true);
    }));

    beforeEach(inject(function (_$rootScope_, _$sync_, _$q_, _$timeout_, _$syncGarbageCollector_, _$socketio_) {
        $rootScope = _$rootScope_;
        $q = _$q_;
        $timeout = _$timeout_;

        var syncCallbacks = {
            onUpdate: function () { },
            onRemove: function () { },
            onAdd: function () { },
            onReady: function () { }
        }

        spec = {
            syncCallbacks: syncCallbacks,
            garbageCollector: _$syncGarbageCollector_,
            $sync: _$sync_,
            $socketio: _$socketio_
        }



        jasmine.clock().install();
        jasmine.clock().mockDate();
    }));

    beforeEach(function setupData() {
        spec.r1 = { id: 1, description: 'person1', revision: 0 };
        spec.r1b = { id: 1, description: 'personOne', revision: 1 };
        spec.r2 = { id: 2, description: 'person2', revision: 4 };
        spec.r3 = { id: 3, description: 'person3', revision: 5 };
        spec.recordWithNoRevision = { id: 44, description: 'person44' };

        spec.rc1 = { id: { id1: 1, id2: 1 }, description: 'person1', revision: 0 };
        spec.rc1b = { id: { id1: 1, id2: 1 }, description: 'personOne', revision: 1 };
        spec.rc2 = { id: { id1: 2, id2: 1 }, description: 'person2', revision: 4 };
        spec.rc3 = { id: { id1: 3, id2: 1 }, description: 'person3', revision: 5 };


        Person = definePersonClass();
        spec.p1 = new Person({ id: 1, firstname: 'Tom', lastname: 'Great', revision: 1 });
        spec.p1b = new Person({ id: 1, firstname: 'Tom', lastname: 'Greater', revision: 2 });
        spec.p2 = new Person({ id: 2, firstname: 'John', lastname: 'Super', revision: 1 });
    });


    beforeEach(function setupSpies() {
        spyOn(backend, 'subscribe').and.callThrough();
        spyOn(backend, 'unsubscribe').and.callThrough();
        spyOn(backend, 'acknowledge');

        spyOn(spec.$socketio, 'fetch').and.callThrough();

        spyOn(spec.garbageCollector, 'dispose').and.callThrough();
        spyOn(spec.garbageCollector, 'run').and.callThrough();

        spyOn(spec.syncCallbacks, 'onUpdate');
        spyOn(spec.syncCallbacks, 'onRemove');
        spyOn(spec.syncCallbacks, 'onAdd');
        spyOn(spec.syncCallbacks, 'onReady');
    });


    afterEach(function () {
        jasmine.clock().tick(10000);
        jasmine.clock().uninstall();
    });

    it('should subscribe and acknowledge to receive empty list', function (done) {
        expect(backend.acknowledge).not.toHaveBeenCalled();
        spec.sds = spec.$sync.subscribe('myPub');
        expect(spec.sds.isSyncing()).toBe(false);
        expect(backend.subscribe).not.toHaveBeenCalled();
        var promise = spec.sds.waitForDataReady();
        expect(backend.subscribe).toHaveBeenCalled();
        expect(spec.sds.isSyncing()).toBe(true);
        expect(backend.unsubscribe).not.toHaveBeenCalled();
        promise.then(function (data) {
            expect(backend.acknowledge).toHaveBeenCalled();
            expect(data.length).toBe(0);
            done();
        });
        $rootScope.$digest();
    });


    it('should subscribe and acknowledge to receive inital data', function (done) {
        backend.setData([spec.r1, spec.r2]);
        expect(backend.acknowledge).not.toHaveBeenCalled();
        spec.sds = spec.$sync.subscribe('myPub');
        expect(spec.sds.isSyncing()).toBe(false);
        var promise = spec.sds.waitForDataReady();
        expect(spec.sds.isSyncing()).toBe(true);
        promise.then(function (data) {
            expect(backend.acknowledge).toHaveBeenCalled();
            expect(data.length).toBe(2);
            expect(!!_.find(data, spec.r1)).toBe(true);
            expect(!!_.find(data, spec.r2)).toBe(true);
            done();
        });
        $rootScope.$digest();
    });

    describe('Syncinc actitivity', function () {
        beforeEach(function () {
            backend.setData([spec.r1, spec.r2]);
            spec.sds = spec.$sync.subscribe('myPub');
        });

        it('should NOT start right after subscribing', function () {
            expect(spec.sds.isSyncing()).toBe(false);
        });

        it('should start when setting syncing to on', function () {
            spec.sds.syncOn();
            expect(spec.sds.isSyncing()).toBe(true);
        });
        
        it('should start when setting params', function () {
            spec.sds.setParameters();
            expect(spec.sds.isSyncing()).toBe(true);
        });

        it('should start when waiting on data ready', function () {
            spec.sds.waitForDataReady();
            expect(spec.sds.isSyncing()).toBe(true);
        });

        it('should start when waiting on subscription is ready', function (done) {
            var promise = spec.sds.waitForSubscriptionReady();
            expect(spec.sds.isSyncing()).toBe(true);
            promise.then(function (sub) {
                expect(spec.sds).toEqual(sub);
                done();
            });
            $rootScope.$digest();
        });
    });

    it('should unsubscribe when subscription is destroyed', function (done) {
        spec.sds = spec.$sync.subscribe('myPub');
        spec.sds.waitForDataReady();
        $rootScope.$digest();
        expect(spec.sds.isSyncing()).toBe(true);
        expect(backend.unsubscribe).not.toHaveBeenCalled();
        spec.sds.destroy();
        expect(spec.sds.isSyncing()).toBe(false);
        expect(backend.unsubscribe).toHaveBeenCalled();
        done();
    });

    it('should unsubscribe when attached scope is destroyed', function (done) {
        var scope = $rootScope.$new();
        spec.sds = spec.$sync.subscribe('myPub');
        spec.sds.attach(scope);
        spec.sds.waitForDataReady();
        $rootScope.$digest();
        expect(spec.sds.isSyncing()).toBe(true);

        scope.$destroy();
        expect(spec.sds.isSyncing()).toBe(false);
        expect(backend.unsubscribe).toHaveBeenCalled();
        done();
    });

    it('should unsubscribe when provided scope is destroyed', function (done) {
        var scope = $rootScope.$new();
        spec.sds = spec.$sync.subscribe('myPub', scope);
        spec.sds.waitForDataReady();
        $rootScope.$digest();
        expect(spec.sds.isSyncing()).toBe(true);
        expect(backend.unsubscribe).not.toHaveBeenCalled();
        scope.$destroy();
        expect(spec.sds.isSyncing()).toBe(false);
        expect(backend.unsubscribe).toHaveBeenCalled();
        done();
    });

    // it('should not allow attaching a different scope after initialization', function () {
    //     spec.sds = spec.$sync.subscribe('myPub');
    //     spec.sds.waitForDataReady();

    // });

    // it('should not allow changing to single object synchronization mode after initialization', function () {
    // });

    it('should not allow changing to set the object class after starting syncing', function () {
        spec.sds = spec.$sync.subscribe('myPub');
        spec.sds.waitForDataReady();
        spec.sds.setObjectClass(Person);
        expect(spec.sds.getObjectClass()).toBeUndefined();
    });

    describe('Data Array sync', function () {
        beforeEach(function () {
            backend.setData([spec.r1, spec.r2]);
            spec.sds = spec.$sync.subscribe('myPub');
        });

        it('should receive an array', function (done) {
            spec.sds.waitForDataReady().then(function (data) {
                expect(_.isArray(data)).toBe(true);
                done();
            });
            $rootScope.$digest();
        });

        it('should NOT allow syncing data without revision property', function (done) {
            spec.sds.waitForDataReady().then(function (data) {
                try {
                    backend.notifyDataChanges([spec.recordWithNoRevision]);
                } catch (err) {

                    expect(err.message).toBe('Sync requires a revision or timestamp property in received record');
                    done();
                }
            });
            $rootScope.$digest();
        });

        // one or list to test... check if instance is maintained too.
        it('should add a record to the array when receiving an add operation', function (done) {
            spec.sds.waitForDataReady().then(function (data) {
                expect(data.length).toBe(2);
                backend.notifyDataChanges([spec.r3]);
                expect(data.length).toBe(3);
                expect(!!_.find(data, { id: spec.r3.id })).toBe(true);
                done();
            });
            $rootScope.$digest();
        });

        it('should update existing record in the array when receiving an update operation', function (done) {
            spec.sds.waitForDataReady().then(function (data) {
                expect(data.length).toBe(2);
                var rec = _.find(data, { id: spec.r1.id });
                backend.notifyDataChanges([spec.r1b]);
                expect(data.length).toBe(2);
                expect(rec).toBeDefined();
                expect(rec.description).toBe(spec.r1b.description);
                done();
            });
            $rootScope.$digest();
        });

        it('should remove a record from array when receiving a removal operation', function (done) {
            spec.sds.waitForDataReady().then(function (data) {
                expect(data.length).toBe(2);
                backend.notifyDataRemovals([{ id: spec.r2.id, revision: spec.r2.revision + 1 }]);
                expect(data.length).toBe(1);
                expect(_.find(data, { id: spec.r2.id })).not.toBeDefined();
                done();
            });
            $rootScope.$digest();
        });
    });


    describe('Data Array sync with composite key', function () {
        beforeEach(function () {
            backend.setData([spec.rc1, spec.rc2]);
            spec.sds = spec.$sync.subscribe('myPub');
        });

        it('should receive an array', function (done) {
            spec.sds.waitForDataReady().then(function (data) {
                expect(_.isArray(data)).toBe(true);
                expect(data.length).toBe(2);
                done();
            });
            $rootScope.$digest();
        });

        // one or list to test... check if instance is maintained too.
        it('should add a record to the array when receiving an add operation', function (done) {
            spec.sds.waitForDataReady().then(function (data) {
                expect(data.length).toBe(2);
                backend.notifyDataChanges([spec.rc3]);
                expect(data.length).toBe(3);
                expect(!!findRecord(data, spec.rc3.id)).toBe(true);
                done();
            });
            $rootScope.$digest();
        });

        it('should update existing record in the array when receiving an update operation', function (done) {
            spec.sds.waitForDataReady().then(function (data) {
                expect(data.length).toBe(2);
                var rec = _.find(data, { id: spec.rc1.id });
                backend.notifyDataChanges([spec.rc1b]);
                expect(data.length).toBe(2);
                expect(rec).toBeDefined();
                expect(rec.description).toBe(spec.rc1b.description);
                done();
            });
            $rootScope.$digest();
        });

        it('should remove a record from array when receiving a removal operation', function (done) {
            spec.sds.waitForDataReady().then(function (data) {
                expect(data.length).toBe(2);
                backend.notifyDataRemovals([{ id: spec.rc2.id, revision: spec.rc2.revision + 1 }]);
                expect(data.length).toBe(1);
                expect(findRecord(data, spec.r2.id)).not.toBeDefined();
                done();
            });
            $rootScope.$digest();
        });
    });

    function findRecord(data, id) {
        return _.find(data, function (record) {
            return spec.$sync.getIdValue(record.id) === spec.$sync.getIdValue(id);
        }
        );
    }
    describe('Single record sync', function () {
        beforeEach(function () {
            backend.setData([spec.r1]);
            spec.sds = spec.$sync.subscribe('myPub')
                .setSingle(true);
            $rootScope.$digest();
        });

        it('should receive an object', function (done) {
            spec.sds.waitForDataReady().then(function (data) {
                expect(_.isArray(data)).toBe(false);
                done();
            });
            $rootScope.$digest();
        });

        it('should update existing record in the array when receiving an update operation', function (done) {
            spec.sds.waitForDataReady().then(function (data) {
                expect(data.description).toBe(spec.r1.description);
                backend.notifyDataChanges([spec.r1b]);
                expect(data.description).toBe(spec.r1b.description);
                done();
            });
            $rootScope.$digest();
        });

        it('should remove a record from array when receiving a removal operation', function (done) {
            spec.sds.waitForDataReady().then(function (data) {
                backend.notifyDataRemovals([{ id: spec.r1.id, revision: spec.r1.revision + 1 }]);
                expect(data.id).toBeUndefined();
                done();
            });
            $rootScope.$digest();
        });
    });


    describe('Object Array sync', function () {
        beforeEach(function () {
            backend.setData([spec.p2, spec.p1]);
            spec.sds = spec.$sync.subscribe('myPub')
                .setObjectClass(Person);
        });

        it('should receive an array of objects with same class', function (done) {
            spec.sds.waitForDataReady().then(function (data) {
                expect(_.isArray(data)).toBe(true);
                expect(data[0] instanceof Person).toBe(true);
                expect(data[1] instanceof Person).toBe(true);
                done();
            });
            $rootScope.$digest();
        });

        it('should update existing object in the array when receiving an update operation', function (done) {
            spec.sds.waitForDataReady().then(function (data) {
                var object = _.find(data, { id: spec.p1.id });
                expect(data.length).toBe(2);
                backend.notifyDataChanges([spec.p1b]);
                expect(data.length).toBe(2);
                expect(object).toBeDefined();
                expect(object.getFullname()).toBe(spec.p1b.getFullname());
                done();
            });
            $rootScope.$digest();
        });
    });

    describe('Single Object sync', function () {
        beforeEach(function () {
            backend.setData([spec.p1]);
            spec.sds = spec.$sync.subscribe('myPub')
                .setSingle(true)
                .setObjectClass(Person);
        });

        it('should receive an object', function (done) {
            spec.sds.waitForDataReady().then(function (data) {
                console.log('class:' + Object.getPrototypeOf(data));
                expect(data instanceof Person).toBe(true);
                done();
            });
            $rootScope.$digest();
        });

        it('should update existing object when receiving an update operation', function (done) {
            spec.sds.waitForDataReady().then(function (data) {
                expect(data.getFullname()).toBe(spec.p1.getFullname());
                backend.notifyDataChanges([spec.p1b]);
                expect(data.getFullname()).toBe(spec.p1b.getFullname());
                done();
            });
            $rootScope.$digest();
        });

        it('should empty the single object  when receiving a removal operation', function (done) {
            spec.sds.waitForDataReady().then(function (data) {
                backend.notifyDataRemovals([{ id: spec.p1.id, revision: spec.p1.revision + 1 }]);
                expect(data.id).toBeUndefined();
                done();
            });
            $rootScope.$digest();
        });

        it('should NOT empty the object when receiving an OLD removal operation', function (done) {
            spec.sds.waitForDataReady().then(function (data) {
                //debugger;
                backend.notifyDataRemovals([{ id: spec.p1.id, revision: spec.p1.revision }]);
                expect(data.id).toBeDefined();
                done();
            });
            $rootScope.$digest();
        });

        it('should NOT add any object when receiving an OLD removal operation', function (done) {
            spec.sds.waitForDataReady().then(function (data) {
                backend.notifyDataRemovals([{ id: spec.p1.id, revision: spec.p1.revision + 1 }]);
                expect(data.id).toBeUndefined();
                backend.notifyDataRemovals([{ id: spec.p1.id, revision: spec.p1.revision }]);
                expect(data.id).toBeUndefined();
                done();
            });
            $rootScope.$digest();
        });

    });

    describe('Sync Callbacks:', function () {

        describe('onUpdate callback', function () {
            beforeEach(function () {
                backend.setData([spec.r1, spec.r2]);
                spec.sds = spec.$sync.subscribe('myPub');
                spec.sds.onUpdate(spec.syncCallbacks.onUpdate);
            });

            it('should NOT get called on receiving data at initialization', function (done) {
                spec.sds.waitForDataReady().then(function () {
                    expect(spec.syncCallbacks.onUpdate).not.toHaveBeenCalled();
                    done();
                })
                $rootScope.$digest();
            });

            it('should get called on receiving updated data', function (done) {
                spec.sds.waitForDataReady().then(function () {
                    backend.notifyDataChanges([spec.r1b]);
                    expect(spec.syncCallbacks.onUpdate).toHaveBeenCalled();
                    done();
                })
                $rootScope.$digest();
            });
        })

        describe('onRemove callback', function () {
            beforeEach(function () {
                backend.setData([spec.r1, spec.r2]);
                spec.sds = spec.$sync.subscribe('myPub');
                spec.sds.onRemove(spec.syncCallbacks.onRemove);
            });

            it('should NOT get called on receiving data at initialization', function (done) {
                spec.sds.waitForDataReady().then(function () {
                    expect(spec.syncCallbacks.onRemove).not.toHaveBeenCalled();
                    done();
                })
                $rootScope.$digest();
            });

            it('should get called on receiving data removal', function (done) {
                spec.sds.waitForDataReady().then(function () {
                    backend.notifyDataRemovals([{ id: spec.r1.id, revision: spec.r1.revision + 1 }]);
                    expect(spec.syncCallbacks.onRemove).toHaveBeenCalled();
                    done();
                })
                $rootScope.$digest();
            });
        });

        describe('onAdd callback', function () {
            beforeEach(function () {
                backend.setData([spec.r1, spec.r2]);
                spec.sds = spec.$sync.subscribe('myPub');
                spec.sds.onAdd(spec.syncCallbacks.onAdd);
            });

            it('should ALSO get called on receiving data at initialization', function (done) {
                spec.sds.waitForDataReady().then(function () {
                    expect(spec.syncCallbacks.onAdd).toHaveBeenCalled();
                    done();
                })
                $rootScope.$digest();
            });

            it('should get called on receiving data removal', function (done) {
                spec.sds.waitForDataReady().then(function () {
                    backend.notifyDataChanges([spec.r1b]);
                    expect(spec.syncCallbacks.onAdd).toHaveBeenCalled();
                    done();
                })
                $rootScope.$digest();
            });
        });

        describe('onReady callback', function () {
            beforeEach(function () {
                backend.setData([spec.r1]);
                spec.sds = spec.$sync.subscribe('myPub');
                spec.sds.onReady(spec.syncCallbacks.onReady);
            });

            it('should get called on receiving data at initialization', function (done) {
                spec.sds.waitForDataReady().then(function () {
                    expect(spec.syncCallbacks.onReady).toHaveBeenCalled();
                    done();
                })
                $rootScope.$digest();
            });

            it('should get called on receiving new data ', function (done) {
                spec.sds.waitForDataReady().then(function () {
                    backend.notifyDataChanges([spec.r2]);
                    expect(spec.syncCallbacks.onReady).toHaveBeenCalled();
                    done();
                })
                $rootScope.$digest();
            });
            it('should get called on receiving data update ', function (done) {
                spec.sds.waitForDataReady().then(function () {
                    backend.notifyDataChanges([spec.r1b]);
                    expect(spec.syncCallbacks.onReady).toHaveBeenCalled();
                    done();
                })
                $rootScope.$digest();
            });
            it('should get called on receiving data removal ', function (done) {
                spec.sds.waitForDataReady().then(function () {
                    backend.notifyDataRemovals([spec.r1]);
                    expect(spec.syncCallbacks.onReady).toHaveBeenCalled();
                    done();
                })
                $rootScope.$digest();
            });

        });


        describe('setReady callback', function () {

            it('should get called with an array parameter on receiving data at initialization', function (done) {
                backend.setData([spec.r1, spec.r2]);
                spec.sds = spec.$sync.subscribe('myPub')
                    .setOnReady(function (data) {
                        expect(_.isArray(data)).toBe(true);
                        done();
                    });
                spec.sds.setParameters();
                $rootScope.$digest();
                //                spec.sds.waitForDataReady();
            });


            it('should get called with an array parameter on receiving data on each sync', function (done) {
                var synchronizedData;
                var n = 2;
                backend.setData([spec.r1, spec.r2]);
                spec.sds = spec.$sync.subscribe('myPub')
                    .setOnReady(function (data) {
                        expect(_.isArray(data)).toBe(true);
                        if (!n) {
                            expect(synchronizedData).toBe(data);
                            done();
                        }
                    })
                    .setParameters();
                $rootScope.$digest();
                spec.sds.waitForDataReady().then(function (data) {
                    synchronizedData = data;
                    n--;
                    backend.notifyDataChanges([spec.r3]);
                    n--;
                    backend.notifyDataChanges([spec.r3]);
                });
                $rootScope.$digest();
            });

            it('should get called with an object parameter on receiving data at initialization', function (done) {
                backend.setData([spec.p1]);
                spec.sds = spec.$sync.subscribe('myPub')
                    .setSingle(true)
                    .setObjectClass(Person)
                    .setOnReady(function (data) {
                        expect(data instanceof Person).toBe(true);
                        done();
                    })
                    .setParameters();
                $rootScope.$digest();
                spec.sds.waitForDataReady();
                $rootScope.$digest();
            });


            it('should get called with the same object parameter on each sync', function (done) {
                var synchronizedData;
                var n = 1;
                backend.setData([spec.p1]);
                spec.sds = spec.$sync.subscribe('myPub')
                    .setSingle(true)
                    .setObjectClass(Person)
                    .setOnReady(function (data) {
                        expect(data instanceof Person).toBe(true);
                        if (!n) {
                            expect(synchronizedData).toBe(data);
                            done();
                        }
                    })
                    .setParameters();
                $rootScope.$digest();
                spec.sds.waitForDataReady().then(function (data) {
                    synchronizedData = data;
                    n--;
                    backend.notifyDataChanges([spec.p1b]);
                });
                $rootScope.$digest();
            });

        });
    });

    describe('Garbage collector', function () {

        beforeEach(function () {
            backend.setData([spec.r1, spec.r2]);
            spec.sds = spec.$sync.subscribe('myPub');
        });

        it('should dispose removed record after receiving a removal operation', function (done) {
            spec.sds.waitForDataReady().then(function (data) {
                expect(spec.garbageCollector.dispose).not.toHaveBeenCalled();
                backend.notifyDataRemovals([{ id: spec.r2.id, revision: spec.r2.revision + 1 }]);
                expect(spec.garbageCollector.dispose).toHaveBeenCalled();
                done();
            });
            $rootScope.$digest();
        });

        it('should collect disposed record after some time', function (done) {
            spec.sds.waitForDataReady().then(function (data) {
                backend.notifyDataRemovals([{ id: spec.r2.id, revision: spec.r2.revision + 1 }]);
                expect(spec.garbageCollector.run).not.toHaveBeenCalled();
                expect(spec.sds.isExistingStateFor(spec.r2)).toBe(true);
                // this is the time it takes before the spec.garbageCollector runs;
                jasmine.clock().tick(spec.garbageCollector.getSeconds() * 1000 + 100);
                expect(spec.garbageCollector.run).toHaveBeenCalled();
                expect(spec.sds.isExistingStateFor(spec.r2)).toBe(false);
                done();
            });
            $rootScope.$digest();
        })
    });


    it('should force a resubscription after network loss', function (done) {
        backend.setData([spec.r1, spec.r2]);
        var $scope = $rootScope.$new(true);
        spec.sds = spec.$sync.subscribe('myPub', $scope);
        spec.sds.setParameters();
        $scope.$digest();
        jasmine.clock().tick(2100); // the subscription does not listen to connection event right away (Need better handling)
        spec.sds.waitForDataReady().then(function (data) {
            // initial subscription call
            expect(spec.$socketio.fetch.calls.count()).toEqual(1);
            $scope.$broadcast('user_connected');
            expect(spec.$socketio.fetch.calls.count()).toEqual(2);
            // 2nd subscription for reconnect
            expect(spec.$socketio.fetch.calls.mostRecent().args[0]).toEqual('sync.subscribe');
            done();
        });
        $scope.$digest();
    });


    it('should force a reject when trying to resolve a subscription takes too much time', function (done) {
        spec.$socketio.network = false;
        spec.$sync.resolveSubscription('myPub', {}, Person).catch(function (err) {
            expect(err).toEqual('SYNC_TIMEOUT');
            done();
        });
        $rootScope.$digest();
        jasmine.clock().tick(spec.$sync.getGracePeriod() * 1000 + 100); // Time is up. The subscription could not be established
        $rootScope.$digest();
    });


    //         make sure notif and sync works in the app...
    // make sure that callbacks are unregistered
    // then test with params...$q

    // maybe make sure subscribe received subId before sending sync-now...but involved working on server..

    //////////////////////////////////////////////
    function definePersonClass() {
        function Person(obj) {
            this.firstname = obj.firstname;
            this.lastname = obj.lastname;
            this.id = obj.id;
            this.revision = obj.revision;
            this.getAbbrevation = function () {
                return this.firstname.substring(0, 1) + this.lastname.substring(0, 1);
            }
        }
        Person.prototype.getFullname = function () {
            return this.firstname + ' ' + this.lastname;
        }
        return Person;
    }



    function MockBackend() {
        var db = {};
        var isSubscribedOnBackend = false;

        var self = this;
        this.onPublicationNotficationCallback = null;
        this.setData = setData;
        this.notifyDataChanges = notifyDataChanges;
        this.notifyDataRemovals = notifyDataRemovals;
        this.subscribe = subscribe;
        this.unsubscribe = unsubscribe;
        this.acknowledge = acknowledge;

        function setData(data) {
            copyAll(data).forEach(function (record) {
                db[spec.$sync.getIdValue(record)] = record;
            });
        }

        function copyAll(array) {
            var r = [];
            array.forEach(function (i) {
                r.push(angular.copy(i));
            })
            return r;
        }

        function notifyDataChanges(data) {
            data = copyAll(data);
            data.forEach(function (record) {
                db[spec.$sync.getIdValue(record)] = record;
            })
            if (isSubscribedOnBackend) {
                self.onPublicationNotficationCallback({
                    name: 'myPub',
                    subscriptionId: 'sub#1',
                    records: data,
                    diff: true
                }, self.acknowledge);
            }
        }

        function notifyDataRemovals(data) {
            data = copyAll(data);
            data.forEach(function (record) {
                record.remove = true;
                delete db[spec.$sync.getIdValue(record)];
            });
            if (isSubscribedOnBackend) {
                self.onPublicationNotficationCallback({
                    name: 'myPub',
                    subscriptionId: 'sub#1',
                    records: data,
                    diff: true
                }, self.acknowledge);
            }
        }

        function subscribe(data) {
            //console.log("fetch: " + operation, data);
            return $q.resolve('sub#1').then(function (subId) {
                isSubscribedOnBackend = true;
                self.onPublicationNotficationCallback({
                    name: 'myPub',
                    records: Object.keys(db).length ? _.values(db) : []
                }, self.acknowledge);
                return subId;
            })
        }

        function unsubscribe(data) {
            console.log("Unsubscribed: " + JSON.stringify(data));
            isSubscribedOnBackend = false;
            return $q.resolve();
        }

        function acknowledge(ack) {
            console.log('Client acknowledge receiving data');
        }
    }

    function MockSocketio() {
        var self = this;
        this.network = true;

        this.on = function (event, callback) {
            // if (!self.network) {
            //     return $q.defer().promise;
            // }
            console.log("ON: " + event);
            if (event === 'SYNC_NOW') {
                backend.onPublicationNotficationCallback = callback;
            }
        }
        this.fetch = function (operation, data) {
            if (!self.network) {
                // never returns..
                return $q.defer().promise;
            }

            if (operation === 'sync.subscribe') {
                return backend.subscribe(data);
            }
            if (operation === 'sync.unsubscribe') {
                return backend.unsubscribe(data);
            }
        }

    }
});
