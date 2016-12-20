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
        expect(currentVersion.o.p).toEqual(updateVersion.o.p);
    });

    fit('should not have circular issue when merging same object', function () {
        var child = { name: 'Boy' };
        var parents = {
            firstChild:child
        };
        child.parents = parents;
        var currentVersion = {
            firstChild: child,
            parents: parents
        }

        var updateChild = { name: 'Teenage boy' };
        var updateParents = {
            firstChild:updateChild
        };
        updateChild.parents = updateParents;
        var updateVersion = {            
            firstChild: updateChild,
            parents: updateParents
            
        }

        syncMerge.update(currentVersion, updateVersion);

        expect(currentVersion.parents === parents).toEqual(true);

        expect(currentVersion.firstChild).toEqual(child);
        expect(currentVersion.firstChild.name).toEqual(updateChild.name);
        expect(currentVersion.firstChild.parents).toEqual(child.parents);

        expect(currentVersion.firstChild.parents.name).toEqual(updateParents.name);

    });


    it('should not have circular issue when merging same object', function () {
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

        expect(currentVersion.parents === parents).toEqual(true);

        expect(currentVersion.firstChild).toEqual(child);
        expect(currentVersion.firstChild.name).toEqual(updateChild2.name);
        expect(currentVersion.firstChild.parents).toEqual(child.parents);

        expect(currentVersion.firstChild.parents.name).toEqual(updateParents.name);
        // in the array we lose the references, there is no way to identify which object needs to be replaced without an id
        expect(currentVersion.parents.children[0]).toEqual(updateChild);
        expect(currentVersion.parents.children[1]).toEqual(updateChild2);

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


    it ('should work', function () {

        var o = {};        

        var updateO = { "id":"5877f444-75e1-46b3-b1f0-a6af2a53f4f5", "opportunityId":"80ccff5c-80dd-4312-9c7a-af2473fc91e8", "currencyCode":"USD", "description":"Multi-phase Approach Quote", "display":"Multi-phase Approach Quote", "hoursPerDay":8, "isPrimary":true, "revision":67, "tracks":[{ "blocks": [{ "blocks": [], "blockCost": 5040, "blockRevenue": 9360, "blockStandardRevenue": 0, "blockHours": 72, "content": [], "description": "", "display": "Plan", "end": "2016-09-10T04:00:00.000Z", "fillColorId": { "level": 0, "baseId": 0 }, "id": "38712e5f-bec8-4afe-b78f-d5c295fe55f5", "isMilestone": false, "nextBlockId": "b9df8185-23ef-4145-bfb9-0f23bae561d8", "parentBlockId": null, "position": { "left": 50, "height": 60, "top": 74, "width": 80 }, "previousBlockId": null, "start": "2016-08-31T04:00:00.000Z", "svgid": "b_38712e5fbec84afeb78fd5c295fe55f5", "tag": null, "trackId": "c86c76ee-a3fe-49bd-828b-f44e68b34d45" }, { "blocks": [], "blockCost": 25200, "blockRevenue": 39600, "blockStandardRevenue": 0, "blockHours": 360, "content": [], "description": "", "display": "Design", "end": "2016-10-03T04:00:00.000Z", "fillColorId": { "level": 0, "baseId": 1 }, "id": "b9df8185-23ef-4145-bfb9-0f23bae561d8", "isMilestone": false, "nextBlockId": "80184bf2-f663-4e79-8a5b-c60df51f3c7f", "parentBlockId": null, "position": { "left": 130, "height": 60, "top": 74, "width": 150 }, "previousBlockId": "38712e5f-bec8-4afe-b78f-d5c295fe55f5", "start": "2016-09-10T04:00:00.000Z", "svgid": "b_b9df818523ef4145bfb90f23bae561d8", "tag": null, "trackId": "c86c76ee-a3fe-49bd-828b-f44e68b34d45" }, { "blocks": [], "blockCost": 33024, "blockRevenue": 53504, "blockStandardRevenue": 0, "blockHours": 896, "content": [], "description": "", "display": "Development", "end": "2016-10-25T04:00:00.000Z", "fillColorId": { "level": 0, "baseId": 2 }, "id": "80184bf2-f663-4e79-8a5b-c60df51f3c7f", "isMilestone": false, "nextBlockId": "34cde95a-a88f-4b81-83d7-28a65605eaea", "parentBlockId": null, "position": { "left": 280, "height": 60, "top": 74, "width": 160 }, "previousBlockId": "b9df8185-23ef-4145-bfb9-0f23bae561d8", "start": "2016-10-03T04:00:00.000Z", "svgid": "b_80184bf2f6634e798a5bc60df51f3c7f", "tag": null, "trackId": "c86c76ee-a3fe-49bd-828b-f44e68b34d45" }, { "blocks": [{ "blocks": [], "blockCost": 0, "blockRevenue": 0, "blockStandardRevenue": 0, "blockHours": 0, "content": [], "description": "", "display": "CRP I", "end": "2016-11-01T04:00:00.000Z", "fillColorId": { "level": 0, "baseId": 0 }, "id": "389ad0ca-5a55-4c01-b4d7-bacef45b7cf3", "isMilestone": false, "nextBlockId": "b3509305-e13d-444b-96e9-20bd3a660e57", "parentBlockId": "34cde95a-a88f-4b81-83d7-28a65605eaea", "position": { "left": 440, "height": 60, "top": 135, "width": 50 }, "previousBlockId": null, "start": "2016-10-25T04:00:00.000Z", "svgid": "b_389ad0ca5a554c01b4d7bacef45b7cf3", "tag": null, "trackId": "c86c76ee-a3fe-49bd-828b-f44e68b34d45" }, { "blocks": [], "blockCost": 0, "blockRevenue": 0, "blockStandardRevenue": 0, "blockHours": 0, "content": [], "description": "", "display": "CRP II", "end": "2016-11-08T05:00:00.000Z", "fillColorId": { "level": 0, "baseId": 0 }, "id": "b3509305-e13d-444b-96e9-20bd3a660e57", "isMilestone": false, "nextBlockId": null, "parentBlockId": "34cde95a-a88f-4b81-83d7-28a65605eaea", "position": { "left": 490, "height": 60, "top": 135, "width": 50 }, "previousBlockId": "389ad0ca-5a55-4c01-b4d7-bacef45b7cf3", "start": "2016-11-01T04:00:00.000Z", "svgid": "b_b3509305e13d444b96e920bd3a660e57", "tag": null, "trackId": "c86c76ee-a3fe-49bd-828b-f44e68b34d45" }], "blockCost": 20640, "blockRevenue": 33440, "blockStandardRevenue": 0, "blockHours": 560, "content": [], "description": "", "display": "Testing", "end": "2016-11-08T05:00:00.000Z", "fillColorId": { "level": 0, "baseId": 3 }, "id": "34cde95a-a88f-4b81-83d7-28a65605eaea", "isMilestone": false, "nextBlockId": "5e69108f-3abc-471d-b8ac-90e37f00208b", "parentBlockId": null, "position": { "left": 440, "height": 60, "top": 74, "width": 100 }, "previousBlockId": "80184bf2-f663-4e79-8a5b-c60df51f3c7f", "start": "2016-10-25T04:00:00.000Z", "svgid": "b_34cde95aa88f4b8183d728a65605eaea", "tag": null, "trackId": "c86c76ee-a3fe-49bd-828b-f44e68b34d45" }, { "blocks": [], "blockCost": 29488, "blockRevenue": 48848, "blockStandardRevenue": 0, "blockHours": 872, "content": [], "description": "", "display": "Deployment", "end": "2016-12-01T05:00:00.000Z", "fillColorId": { "level": 0, "baseId": 4 }, "id": "5e69108f-3abc-471d-b8ac-90e37f00208b", "isMilestone": false, "nextBlockId": "34c0286b-07fb-4e56-a978-aec5670686c0", "parentBlockId": null, "position": { "left": 540, "height": 60, "top": 74, "width": 170 }, "previousBlockId": "34cde95a-a88f-4b81-83d7-28a65605eaea", "start": "2016-11-08T05:00:00.000Z", "svgid": "b_5e69108f3abc471db8ac90e37f00208b", "tag": null, "trackId": "c86c76ee-a3fe-49bd-828b-f44e68b34d45" }, { "blocks": [], "blockCost": 4720, "blockRevenue": 8720, "blockStandardRevenue": 0, "blockHours": 200, "content": [], "description": "", "display": "Support", "end": "2017-01-03T05:00:00.000Z", "fillColorId": { "level": 0, "baseId": 0 }, "id": "34c0286b-07fb-4e56-a978-aec5670686c0", "isMilestone": false, "nextBlockId": null, "parentBlockId": null, "position": { "left": 710, "height": 60, "top": 74, "width": 230 }, "previousBlockId": "5e69108f-3abc-471d-b8ac-90e37f00208b", "start": "2016-12-01T05:00:00.000Z", "svgid": "b_34c0286b07fb4e56a978aec5670686c0", "tag": null, "trackId": "c86c76ee-a3fe-49bd-828b-f44e68b34d45" }], "content": [], "createdBlocks": 0, "description": null, "display": "Mobile Development Project", "expenseEstimatePercentage": 7, "expenseUom": { "code": "HRS", "display": "Hours", "type": "time", "base": true, "conversion": 1 }, "expenseAmountValue": null, "id": "c86c76ee-a3fe-49bd-828b-f44e68b34d45", "location": { "code": "USA", "code2": "US", "code_number": "840", "display": "United States" }, "position": { "left": 0, "height": 4, "top": 0, "width": "100%" }, "pricingModelId": null, "resourceProfiles": [{ "id": "1dab9f88-4d47-40b7-a7a4-305e27b3a115", "display": "Project Manager", "resourceTypeCode": "People", "description": "As the project manager, your job is to plan, budget, oversee and document all aspects of the specific project you are working on. Project managers may work closely with upper management to make sure that the scope and direction of each project is on schedule, as well as other departments for support.", "practiceId": "", "rateUomCode": "Hours", "isProfile": false, "profileId": null, "clonedFromId": "2a27ba8c-b8cc-4f27-b980-c864a52e96d0", "unitCost": 70, "unitRate": 130, "standardCost": 70, "standardRate": 130, "sourceOrgId": null, "isCustomer": false, "isEmployee": true, "isExpenses": true, "isOnSite": true, "trackId": "c86c76ee-a3fe-49bd-828b-f44e68b34d45", "allocations": [{ "id": "2adbd92f-3c81-4560-bf47-350febe3d8b5", "resourceId": "1dab9f88-4d47-40b7-a7a4-305e27b3a115", "blockId": "38712e5f-bec8-4afe-b78f-d5c295fe55f5", "start": "2016-08-31T04:00:00.000Z", "end": "2016-09-12T04:00:00.000Z", "allocatedHours": 9, "position": { "left": 0, "height": 3, "top": 0, "width": 100 } }, { "id": "6fb6e1de-d3c6-4dbe-8fd0-2d38d95bb361", "resourceId": "1dab9f88-4d47-40b7-a7a4-305e27b3a115", "blockId": "b9df8185-23ef-4145-bfb9-0f23bae561d8", "start": "2016-09-12T04:00:00.000Z", "end": "2016-10-03T04:00:00.000Z", "allocatedHours": 8, "position": { "left": 0, "height": 3, "top": 0, "width": 100 } }, { "id": "9e49ee21-5f78-4791-9b88-63de023799d3", "resourceId": "1dab9f88-4d47-40b7-a7a4-305e27b3a115", "blockId": "80184bf2-f663-4e79-8a5b-c60df51f3c7f", "start": "2016-10-03T04:00:00.000Z", "end": "2016-10-25T04:00:00.000Z", "allocatedHours": 8, "position": { "left": 0, "height": 3, "top": 0, "width": 100 } }, { "id": "189de381-81dc-446f-9a47-7e8839f8fb2c", "resourceId": "1dab9f88-4d47-40b7-a7a4-305e27b3a115", "blockId": "34cde95a-a88f-4b81-83d7-28a65605eaea", "start": "2016-10-25T04:00:00.000Z", "end": "2016-11-08T05:00:00.000Z", "allocatedHours": 8, "position": { "left": 0, "height": 3, "top": 0, "width": 100 } }, { "id": "5c09331e-9cbd-4763-8710-1be3fb27d878", "resourceId": "1dab9f88-4d47-40b7-a7a4-305e27b3a115", "blockId": "5e69108f-3abc-471d-b8ac-90e37f00208b", "start": "2016-11-08T05:00:00.000Z", "end": "2016-12-01T05:00:00.000Z", "allocatedHours": 8, "position": { "left": 0, "height": 3, "top": 0, "width": 100 } }, { "id": "785dacb6-e778-482e-9e33-00e823f13f2b", "resourceId": "1dab9f88-4d47-40b7-a7a4-305e27b3a115", "blockId": "34c0286b-07fb-4e56-a978-aec5670686c0", "start": "2016-12-01T05:00:00.000Z", "end": "2016-12-08T05:00:00.000Z", "allocatedHours": 8, "position": { "left": 0, "height": 3, "top": 0, "width": 100 } }], "position": { "left": 25, "height": 56, "top": 225, "width": 0 }, "quantity": 1, "orgRates": [], "sortOrder": 0, "leadTimeDays": 0, "skillsets": [], "tag": "Management", "isDisabled": false, "revision": 0, "timestamp": { "revision": 0, "createdById": null, "createdDate": null, "lastModifiedById": null, "lastModifiedDate": null } }, { "id": "6b495a04-4e11-421d-830f-54584aa5f7e1", "display": "Functionl Consultant", "resourceTypeCode": "People", "description": "", "practiceId": "", "rateUomCode": "Hours", "isProfile": false, "profileId": null, "clonedFromId": null, "unitCost": 70, "unitRate": 100, "standardCost": 70, "standardRate": 100, "sourceOrgId": null, "isCustomer": false, "isEmployee": true, "isExpenses": true, "isOnSite": true, "trackId": "c86c76ee-a3fe-49bd-828b-f44e68b34d45", "allocations": [{ "id": "47c72720-512e-4182-b97f-1ec865308076", "resourceId": "6b495a04-4e11-421d-830f-54584aa5f7e1", "blockId": "b9df8185-23ef-4145-bfb9-0f23bae561d8", "start": "2016-09-12T04:00:00.000Z", "end": "2016-10-03T04:00:00.000Z", "allocatedHours": 8, "position": { "left": 0, "height": 3, "top": 0, "width": 100 } }, { "id": "54a511f7-f201-4575-9e00-c472521a9acf", "resourceId": "6b495a04-4e11-421d-830f-54584aa5f7e1", "blockId": "80184bf2-f663-4e79-8a5b-c60df51f3c7f", "start": "2016-10-03T04:00:00.000Z", "end": "2016-10-25T04:00:00.000Z", "allocatedHours": 8, "position": { "left": 0, "height": 3, "top": 0, "width": 100 } }, { "id": "9d504bac-1103-4eb2-8ad1-1c1d014302ed", "resourceId": "6b495a04-4e11-421d-830f-54584aa5f7e1", "blockId": "34cde95a-a88f-4b81-83d7-28a65605eaea", "start": "2016-10-25T04:00:00.000Z", "end": "2016-11-08T05:00:00.000Z", "allocatedHours": 8, "position": { "left": 0, "height": 3, "top": 0, "width": 100 } }, { "id": "5df2cf44-967c-41f2-9e9c-835ca10b3d96", "resourceId": "6b495a04-4e11-421d-830f-54584aa5f7e1", "blockId": "5e69108f-3abc-471d-b8ac-90e37f00208b", "start": "2016-11-08T05:00:00.000Z", "end": "2016-11-24T05:00:00.000Z", "allocatedHours": 8, "position": { "left": 0, "height": 3, "top": 0, "width": 100 } }], "position": { "left": 25, "height": 56, "top": 270, "width": 0 }, "quantity": 2, "orgRates": [], "sortOrder": 1, "leadTimeDays": 0, "skillsets": [], "tag": "Functional", "isDisabled": false, "revision": 5, "timestamp": { "revision": 0, "createdById": "0e20fec5-a28b-4f68-8a09-79fba40b0041", "createdDate": "2016-10-19T23:27:59.777Z", "lastModifiedById": "0e20fec5-a28b-4f68-8a09-79fba40b0041", "lastModifiedDate": "2016-10-19T23:32:39.424Z" } }, { "id": "7f12a60f-db4a-4a43-8d84-fe6b884cf7ea", "display": "Offshore Functional Consultant (India)", "resourceTypeCode": "People", "description": "", "practiceId": "", "rateUomCode": "Hours", "isProfile": false, "profileId": null, "clonedFromId": null, "unitCost": 14, "unitRate": 26, "standardCost": 14, "standardRate": 26, "sourceOrgId": null, "isCustomer": false, "isEmployee": false, "isExpenses": true, "isOnSite": false, "trackId": "c86c76ee-a3fe-49bd-828b-f44e68b34d45", "allocations": [], "position": { "left": 25, "height": 45, "top": 315, "width": 0 }, "quantity": 5, "orgRates": [], "sortOrder": 2, "leadTimeDays": 0, "skillsets": [], "tag": "Functional", "isDisabled": false, "revision": 5, "timestamp": { "revision": 0, "createdById": "0e20fec5-a28b-4f68-8a09-79fba40b0041", "createdDate": "2016-10-19T23:27:59.777Z", "lastModifiedById": "0e20fec5-a28b-4f68-8a09-79fba40b0041", "lastModifiedDate": "2016-10-19T23:32:39.424Z" } }, { "id": "0a52090c-299b-45e3-bb5c-b080bcdd29bf", "display": "Offshore Technical Consultant (India)", "resourceTypeCode": "People", "description": "", "practiceId": "", "rateUomCode": "Hours", "isProfile": false, "profileId": null, "clonedFromId": null, "unitCost": 12, "unitRate": 22, "standardCost": 12, "standardRate": 22, "sourceOrgId": null, "isCustomer": false, "isEmployee": true, "isExpenses": true, "isOnSite": false, "trackId": "c86c76ee-a3fe-49bd-828b-f44e68b34d45", "allocations": [{ "id": "d81ee194-d91c-42f3-87a4-355a0fb89472", "resourceId": "0a52090c-299b-45e3-bb5c-b080bcdd29bf", "blockId": "80184bf2-f663-4e79-8a5b-c60df51f3c7f", "start": "2016-10-03T04:00:00.000Z", "end": "2016-10-25T04:00:00.000Z", "allocatedHours": 8, "position": { "left": 0, "height": 3, "top": 0, "width": 100 } }, { "id": "d0e03292-867d-4b78-b6a3-b825e28974c1", "resourceId": "0a52090c-299b-45e3-bb5c-b080bcdd29bf", "blockId": "34cde95a-a88f-4b81-83d7-28a65605eaea", "start": "2016-10-25T04:00:00.000Z", "end": "2016-11-08T05:00:00.000Z", "allocatedHours": 8, "position": { "left": 0, "height": 3, "top": 0, "width": 100 } }, { "id": "5d81ae6a-654c-4dd7-a59f-d655354ad692", "resourceId": "0a52090c-299b-45e3-bb5c-b080bcdd29bf", "blockId": "5e69108f-3abc-471d-b8ac-90e37f00208b", "start": "2016-11-08T05:00:00.000Z", "end": "2016-12-01T05:00:00.000Z", "allocatedHours": 8, "position": { "left": 0, "height": 3, "top": 0, "width": 100 } }, { "id": "846ad901-a938-421d-aece-bbd2db914667", "resourceId": "0a52090c-299b-45e3-bb5c-b080bcdd29bf", "blockId": "34c0286b-07fb-4e56-a978-aec5670686c0", "start": "2016-12-01T05:00:00.000Z", "end": "2016-12-08T05:00:00.000Z", "allocatedHours": 8, "position": { "left": 0, "height": 3, "top": 0, "width": 100 } }], "position": { "left": 25, "height": 56, "top": 360, "width": 0 }, "quantity": 4, "orgRates": [], "sortOrder": 3, "leadTimeDays": 0, "skillsets": [], "tag": "Functional", "isDisabled": false, "revision": 5, "timestamp": { "revision": 0, "createdById": "0e20fec5-a28b-4f68-8a09-79fba40b0041", "createdDate": "2016-10-19T23:27:59.777Z", "lastModifiedById": "0e20fec5-a28b-4f68-8a09-79fba40b0041", "lastModifiedDate": "2016-10-19T23:32:39.424Z" } }, { "id": "9e56aaba-2022-4e1b-8d0a-4b6902b08d51", "display": "Testing Lead", "resourceTypeCode": "People", "description": "", "practiceId": "", "rateUomCode": "Hours", "isProfile": false, "profileId": null, "clonedFromId": null, "unitCost": 30, "unitRate": 80, "standardCost": 30, "standardRate": 80, "sourceOrgId": null, "isCustomer": false, "isEmployee": true, "isExpenses": true, "isOnSite": true, "trackId": "c86c76ee-a3fe-49bd-828b-f44e68b34d45", "allocations": [], "position": { "left": 25, "height": 56, "top": 405, "width": 0 }, "quantity": 1, "orgRates": [], "sortOrder": 4, "leadTimeDays": 0, "skillsets": [], "tag": "Functional", "isDisabled": false, "revision": 5, "timestamp": { "revision": 0, "createdById": "0e20fec5-a28b-4f68-8a09-79fba40b0041", "createdDate": "2016-10-19T23:27:59.777Z", "lastModifiedById": "0e20fec5-a28b-4f68-8a09-79fba40b0041", "lastModifiedDate": "2016-10-19T23:32:39.424Z" } }, { "id": "174ad75c-8be0-4d98-a7c7-0b9954958775", "display": "Support (India)", "resourceTypeCode": "People", "description": "", "practiceId": "", "rateUomCode": "Hours", "isProfile": false, "profileId": null, "clonedFromId": null, "unitCost": 12, "unitRate": 19, "standardCost": 12, "standardRate": 19, "sourceOrgId": null, "isCustomer": false, "isEmployee": false, "isExpenses": true, "isOnSite": false, "trackId": "c86c76ee-a3fe-49bd-828b-f44e68b34d45", "allocations": [], "position": { "left": 25, "height": 56, "top": 450, "width": 0 }, "quantity": 3, "orgRates": [], "sortOrder": 5, "leadTimeDays": 0, "skillsets": [], "tag": "Functional", "isDisabled": false, "revision": 5, "timestamp": { "revision": 0, "createdById": "0e20fec5-a28b-4f68-8a09-79fba40b0041", "createdDate": "2016-10-19T23:27:59.777Z", "lastModifiedById": "0e20fec5-a28b-4f68-8a09-79fba40b0041", "lastModifiedDate": "2016-10-19T23:32:39.424Z" } }], "tag": null }], "documents":[], "userRoles":{ },"pricingModelCode":"TE", "timestamp":{ "revision":0, "createdById":"0e20fec5-a28b-4f68-8a09-79fba40b0041", "createdDate":"2016-08-31T19:59:19.853Z", "lastModifiedById":"0e20fec5-a28b-4f68-8a09-79fba40b0041", "lastModifiedDate":"2016-12-20T01:05:27.920Z" },"isDisabled":false};

        syncMerge.update(_.assign(o,updateO), updateO);

        expect(true).toBe(false);
    });


});
