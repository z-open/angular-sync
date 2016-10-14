
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

