describe('SyncGarbageCollector', function () {
    var garbageCollector;
    var data;

    beforeEach(module('sync')); // still dependent on common for now.

    beforeEach(inject(function (_$syncGarbageCollector_) {
        garbageCollector = _$syncGarbageCollector_;
        garbageCollector.setSeconds(2);
        spyOn(garbageCollector, 'schedule').and.callThrough();
        spyOn(garbageCollector, 'run').and.callThrough();

        data = {
            collect: function () { }
        };
        spyOn(data, 'collect');

        jasmine.clock().install();
        jasmine.clock().mockDate();
    }));


    afterEach(function () {
        jasmine.clock().tick(10000);
        jasmine.clock().uninstall();
    });

    it('should NOT schedule any collection at instantiation', function () {
        expect(garbageCollector.schedule).not.toHaveBeenCalled();
        jasmine.clock().tick(3000);
        expect(garbageCollector.schedule).not.toHaveBeenCalled();
    });

    it('should schedule collection when data has just been disposed', function () {
        garbageCollector.dispose(data.collect);
        expect(garbageCollector.schedule).toHaveBeenCalled();
        expect(garbageCollector.run).not.toHaveBeenCalled();

    });

    it('should collect data disposed when expiration', function () {
        garbageCollector.dispose(data.collect);
        jasmine.clock().tick(2010);
        expect(data.collect).toHaveBeenCalled();
        expect(garbageCollector.run).toHaveBeenCalled();
        expect(garbageCollector.getItemCount()).toBe(0);
    });

    it('should NOT collect data disposed recently', function () {
        garbageCollector.dispose(data.collect);
        expect(data.collect).not.toHaveBeenCalled();
        jasmine.clock().tick(1000);
        expect(data.collect).not.toHaveBeenCalled();
         expect(garbageCollector.run).not.toHaveBeenCalled();
        expect(garbageCollector.getItemCount()).toBe(1);
    });

    it('should collect a data disposed recently but not that disposed right after until it is time', function () {
        garbageCollector.dispose(data.collect);
        jasmine.clock().tick(1100);
        garbageCollector.dispose(data.collect);
        expect(garbageCollector.getItemCount()).toBe(2);
        jasmine.clock().tick(1100); // new collection is automatically scheduled to collect record2
        expect(garbageCollector.getItemCount()).toBe(1);
        jasmine.clock().tick(1100);
        expect(garbageCollector.getItemCount()).toBe(1);
        jasmine.clock().tick(1100); // 2nd collection is done now
        expect(garbageCollector.getItemCount()).toBe(0);

    });
});
