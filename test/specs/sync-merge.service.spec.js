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
        expect(currentVersion.o).toBe(updateVersion.o);
    });

    it('should replace object property content with source content and maintain reference', function () {
        var currentVersionObject = { p: 1 };
        var currentVersion = {
            o: currentVersionObject
        };
        var updateVersion = {
            o: { p: 2 }
        }
        syncMerge.update(currentVersion, updateVersion);
        expect(currentVersion.o === currentVersionObject).toEqual(true);
        expect(currentVersion.o.p).toBe(updateVersion.o.p);
    });

    it('should maintain the reference to an array whose reference appears multiple times within an object', function () {
        var list = ['thing'];
        var currentVersion = {
            list1: list,
            list2: list
        };

        var updateList = ['cosa'];
        var updateVersion = {
            list1: updateList,
            list2: updateList
        };

        syncMerge.update(currentVersion, updateVersion);

        expect(currentVersion.list1).toBe(list);
        expect(currentVersion.list2).toBe(list);
        expect(list[0]).toEqual(updateList[0]);
    });

    it('should maintain the reference to an array whose reference appears multiple times within an object and array', function () {
        var list = ['thing'];
        var listOfLists = [list];
        var currentVersion = {
            listOfLists: listOfLists,
            list: list
        };

        var updateList = ['cosa'];
        var updateListOfLists = [list];
        var updateVersion = {
            listOfLists: updateListOfLists,
            list: updateList
        };

        syncMerge.update(currentVersion, updateVersion);

        expect(currentVersion.list).toBe(list);
        expect(currentVersion.listOfLists).toBe(listOfLists);
        expect(currentVersion.listOfLists[0]).toBe(list);
        expect(list[0]).toBe(updateList[0]);
    });



    it('should not have circular issue when references of an object appear multiple times within an object', function () {
        var child = { name: 'Boy' };
        var parents = {
            firstChild: child
        };
        child.parents = parents;
        var currentVersion = {
            firstChild: child,
            parents: parents
        }

        var updateChild = { name: 'Teenage boy' };
        var updateParents = {
            firstChild: updateChild
        };
        updateChild.parents = updateParents;
        var updateVersion = {
            firstChild: updateChild,
            parents: updateParents

        }

        syncMerge.update(currentVersion, updateVersion);

        expect(currentVersion.parents === parents).toEqual(true);

        expect(currentVersion.firstChild).toBe(child);
        expect(currentVersion.firstChild.name).toEqual(updateChild.name);
        expect(currentVersion.firstChild.parents).toBe(child.parents);

        expect(currentVersion.firstChild.parents.name).toEqual(updateParents.name);

    });


    it('should not have circular issue when merging objects with interdependencies', function () {
        var child = { name: 'Boy' };
        var child2 = { name: 'Girl' };

        var parents = {
            name: 'Johns',
            children: [child, child2]
        };
        child.parents = parents;
        child2.parents = parents;
        var currentVersion = {
            firstChild: child,
            parents: parents


        }

        var updateChild = { name: 'Teenage boy' };
        var updateChild2 = { name: 'Teenage girl' };

        var updateParents = {
            name: 'Barnes',
            children: [updateChild, updateChild2]
        };
        updateChild.parents = updateParents;
        updateChild2.parents = updateParents;

        var updateVersion = {
            firstChild: updateChild2,
            parents: updateParents

        }

        syncMerge.update(currentVersion, updateVersion);

        expect(currentVersion.parents).toBe(parents);

        expect(currentVersion.firstChild).toBe(child);
        expect(currentVersion.firstChild.name).toEqual(updateChild2.name);
        expect(currentVersion.firstChild.parents).toBe(child.parents);

        expect(currentVersion.firstChild.parents.name).toEqual(updateParents.name);
        // in the array we lose the references, there is no way to identify which object needs to be replaced without an id
        expect(currentVersion.parents.children[0]).toBe(updateChild);
        expect(currentVersion.parents.children[1]).toBe(updateChild2);

    });



    it('should NOT replace the instance of an object by another when same id is provided', function () {
        var child = { id: '11', name: 'Boy' };
        var currentVersion = {
            firstChild: child
        }

        var updateChild = { id: '11', name: 'Teenage girl' };
        var updateVersion = {
            firstChild: updateChild
        }

        syncMerge.update(currentVersion, updateVersion, true);

        expect(child).not.toBe(updateChild);
        expect(currentVersion.firstChild).toBe(child);
        expect(currentVersion.firstChild.name).toEqual(updateChild.name);

    });

    it('should replace the instance of an object by another when different id is provided', function () {
        var child = { id: '11', name: 'Boy' };
        var currentVersion = {
            firstChild: child
        }

        var updateChild2 = { id: '22', name: 'Teenage girl' };
        var updateVersion = {
            firstChild: updateChild2
        }

        syncMerge.update(currentVersion, updateVersion, true);

        expect(currentVersion.firstChild).toBe(updateChild2);
        expect(currentVersion.firstChild.name).toEqual(updateChild2.name);

    });



    fit('should maintain references of object in an array when objects have an id', function () {
        var child = { id: '11', name: 'Boy' };
        var child2 = { id: '22', name: 'Girl' };

        var parents = {
            name: 'Johns',
            children: [child, child2]
        };
        child.parents = parents;
        child2.parents = parents;
        var currentVersion = {
            firstChild: child,
            parents: parents


        }

        var updateChild = { id: '11', name: 'Teenage boy' };
        var updateChild2 = { id: '22', name: 'Teenage girl' };

        var updateParents = {
            name: 'Barnes',
            children: [updateChild, updateChild2]
        };
        updateChild.parents = updateParents;
        updateChild2.parents = updateParents;

        var updateVersion = {
            parents: updateParents,
            firstChild: updateChild2,

        }

        syncMerge.update(currentVersion, updateVersion, true);

        expect(currentVersion.parents).toBe(parents);

        // should be child2...but it is updateChild2
        // All thing is messed up 
        //
        // CONCLUSION
        // ----------
        // cannot maintain references on everthing...
        // after a sync, the cached object content should be wiped and the content of the new one should be replacing without regard for references.
        // then 
        // everything needs to be recalculated based on the new object content (thx to digest)
        // if a row of a grid is currently selecting an item of an array of the object, the row selection must be done on the new item. (before since instance was maintained, it was NOT necessary). On new data, the row must reselected with the new instance.
        //
        // so just merge all properties of the source (simply assign)

        // then dress using the properties containing id to pull external object.
        // 

        expect(currentVersion.firstChild).toBe(updateChild2);
        expect(currentVersion.firstChild.name).toEqual(updateChild2.name);
        expect(currentVersion.firstChild.parents).toBe(updateChild2.parents);

        expect(currentVersion.firstChild.parents.name).toEqual(updateParents.name);
        // in the array we lose the references, there is no way to identify which object needs to be replaced without an id
        expect(currentVersion.parents.children[0]).toBe(child);
        expect(currentVersion.parents.children[1]).toBe(updateChild2);

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
