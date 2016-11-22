describe('SyncMerge', function () {
    var syncMerge;
    var data;

    beforeEach(module('sync')); // still dependent on common for now.

    beforeEach(inject(function (_$syncMerge_) {
        syncMerge = _$syncMerge_;
    }));



    it('should update empty object with new properties of the source object', function () {
        var currentVersion = {
            // a: 1,
            // b: '2',
            // c: [1,2]
        };
        var updateVersion = {
            a: 11,
            b: '22'
        }
        syncMerge.update(currentVersion, updateVersion);
        expect(currentVersion.a).toEqual(updateVersion.a);
        expect(currentVersion.b).toEqual(updateVersion.b);
    });

    it('should update basic object properties with new property values of the source object', function () {
        var currentVersion = {
            a: 1,
            b: '2'
        };
        var updateVersion = {
            a: 11,
            b: '22'
        }
        syncMerge.update(currentVersion, updateVersion);
        expect(currentVersion.a).toEqual(updateVersion.a);
        expect(currentVersion.b).toEqual(updateVersion.b);
    });

    it('should update object date property with new date value', function () {
        var date = new Date();
        var updateDate = new Date();
        updateDate.setDate(updateDate.getDate() + 1);
        var currentVersion = {
            d: date
        };
        var updateVersion = {
            d: updateDate
        }
        syncMerge.update(currentVersion, updateVersion);
        expect(updateVersion.d instanceof Date).toBe(true);
        expect(currentVersion.d.getTime()).toEqual(updateVersion.d.getTime());
    });


    it('should remove with missing properties', function () {
        var currentVersion = {
            a: 1,
            b: '2'
        };
        var updateVersion = {
            a: 11
        }
        syncMerge.update(currentVersion, updateVersion);
        expect(currentVersion.a).toEqual(updateVersion.a);
        expect(currentVersion.b).toBeUndefined();
    });


    it('should add object property of source', function () {
        var currentVersion = {
        };
        var updateVersion = {
            o: { p: 1 }
        }
        syncMerge.update(currentVersion, updateVersion);
        expect(currentVersion.o).toEqual(updateVersion.o);
    });

    it('should replace object property content not reference with source content', function () {
        var currentVersionObject = { p: 1 };
        var currentVersion = {
            o: currentVersionObject
        };
        var updateVersion = {
            o: { p: 2 }
        }
        syncMerge.update(currentVersion, updateVersion);
        expect(currentVersion.o === currentVersionObject).toEqual(true);
        expect(currentVersion.o.p).toEqual(updateVersion.o.p);
    });


    describe('When merging array', function () {

        it('should add array property with source array property ', function () {
            var currentVersion = {
            };
            var updateVersion = {
                a: [1, 2]
            }
            syncMerge.update(currentVersion, updateVersion);
            expect(currentVersion.a).toEqual(updateVersion.a);
        });


        it('should replace object array property content with the array of the source ', function () {
            var currentVersionArray = [1, 2];
            var currentVersion = {
                a: currentVersionArray
            };
            var updateVersion = {
                a: [1, 2, 3]
            }
            syncMerge.update(currentVersion, updateVersion);
            expect(currentVersion.a).toEqual(currentVersionArray);
            // should not be the same reference
            expect(currentVersion.a === updateVersion.a).toBe(false);
            // but have the same content
            expect(currentVersion.a[0]).toEqual(updateVersion.a[0]);
            expect(currentVersion.a[1]).toEqual(updateVersion.a[1]);
            expect(currentVersion.a[2]).toEqual(updateVersion.a[2]);

        });

        // it('should add array property with source array property ', function () {
        it('should add object array property content with the array of the source ', function () {
            var currentVersionObject = {};
            var currentVersion = {
                o: currentVersionObject
            };
            var updateVersion = {
                o: {
                    a: [2, 3, 4]
                }
            }
            syncMerge.update(currentVersion, updateVersion);
            expect(currentVersion.o.a[0]).toEqual(updateVersion.o.a[0]);
            expect(currentVersion.o.a[1]).toEqual(updateVersion.o.a[1]);
            expect(currentVersion.o.a[2]).toEqual(updateVersion.o.a[2]);
        });



        it('should replace object array property content with the array of the source ', function () {
            var currentVersionArray = [1, 2];
            var currentVersionObject = { a: currentVersionArray };
            var currentVersion = {
                o: currentVersionObject
            };
            var updateVersion = {
                o: {
                    a: [2, 3, 4]
                }
            }
            syncMerge.update(currentVersion, updateVersion);
            expect(currentVersion.o.a).toEqual(currentVersionArray);
            // should not be the same reference
            expect(currentVersion.o.a === updateVersion.o.a).toBe(false);
            // but have the same content
            expect(currentVersion.o.a[0]).toEqual(updateVersion.o.a[0]);
            expect(currentVersion.o.a[1]).toEqual(updateVersion.o.a[1]);
            expect(currentVersion.o.a[2]).toEqual(updateVersion.o.a[2]);
        });

        it('should add array of objects', function () {
            var currentVersionObject = {};
            var currentVersion = {
                o: currentVersionObject
            };
            var updateVersion = {
                o: {
                    a: [{ t: 'one' }, { t: 'another' }]
                }
            }
            syncMerge.update(currentVersion, updateVersion);
            expect(currentVersion.o.a[0].t).toEqual(updateVersion.o.a[0].t);
            expect(currentVersion.o.a[1].t).toEqual(updateVersion.o.a[1].t);
        });

        it('should update object within the array', function () {

            var currentVersionObjectA = { id: '#A', t: 'un' };
            var currentVersionObjectB = { id: '#B', t: 'autre' };
            var currentVersion = {
                a: [currentVersionObjectA, currentVersionObjectB]
            };

            var updateVersionObjectA = { id: '#A', t: 'one' };
            var updateVersionObjectB = { id: '#B', t: 'other' };
            var updateVersion = {
                a: [updateVersionObjectB, updateVersionObjectA]
            }
            syncMerge.update(currentVersion, updateVersion, true);
            // object reference should not have changed for object with same id
            expect(_.find(currentVersion.a, { id: '#A' })).toBeDefined();
            expect(_.find(currentVersion.a, { id: '#A' }) === currentVersionObjectA).toBe(true);

            //object should be updated with the value            
            expect(currentVersionObjectA.t).toEqual(currentVersionObjectA.t);
            expect(currentVersionObjectB.t).toEqual(updateVersionObjectB.t);
        });

        it('should throw an error when merging object without id within an array in strict mode', function () {

            var currentVersionObjectA = { t: 'un' };
            var currentVersion = {
                a: [currentVersionObjectA]
            };

            var updateVersionObjectA = { t: 'one' };
            var updateVersion = {
                a: [updateVersionObjectA]
            }
            try {
                syncMerge.update(currentVersion, updateVersion, true);
                expect(true).toBe(false);
            } catch (e) {
                expect(e.message).toContain('maintain');
            }
        });

        it('should NOT throw an error when merging object without id within an array', function () {
            var currentVersionObjectA = { t: 'un' };
            var currentVersion = {
                a: [currentVersionObjectA]
            };

            var updateVersionObjectA = { t: 'one' };
            var updateVersion = {
                a: [updateVersionObjectA]
            }
            syncMerge.update(currentVersion, updateVersion);

        });




    });



});
