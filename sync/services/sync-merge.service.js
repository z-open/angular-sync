
angular
    .module('sync')
    .factory('$syncMerge', syncMerge);

function syncMerge() {

    return {
        update: update,
        clearObject: clearObject
    }


    /**
     * This function updates an object with the content of another.
     * The inner objects and objects in array will also be updated.
     * References to the original objects are maintained in the destination object so Only content is updated.
     *
     * The properties in the source object that are not in the destination will be removed from the destination object.
     *
     * 
     *
     *@param <object> destination  object to update
     *@param <object> source  object to update from
     *@param <boolean> isStrictMode default false, if true would generate an error if inner objects in array do not have id field
     */

    function update(destination, source, isStrictMode) {

        var processed = [];

        return updateObject(destination, source, isStrictMode);

        function findProcessed(value) {
            if (!_.isArray(value) && !_.isObject(value) && !_.isDate(value) && !_.isFunction(value)) {
                return null;
            }
            var found = _.find(processed, function (p) {
                return value === p.value;
            });
            return found ? found.newValue : null;
        }

        function updateObject(destination, source, isStrictMode) {
            if (!destination) {
                return source;// _.assign({}, source);;
            }
            // create new object containing only the properties of source merge with destination
            var object = {};
            for (var property in source) {
                var processedData = findProcessed(source[property]);

//Object.getOwnPropertyDescriptor                
                var d = Object.getOwnPropertyDescriptor(source, property);
                if (processedData) {
                    object[property] = processedData;
                } else 
                    if (d && (d.set || d.get)) {
                        // do nothing, it is computed
                        
                    } else

                    if (_.isArray(source[property])) {
                        object[property] = updateArray(destination[property], source[property], isStrictMode);

                        processed.push({ value: source[property], newValue: object[property] });

                    } else if (_.isFunction(source[property])) {
                        object[property] = source[property];

                        processed.push({ value: source[property], newValue: object[property] });

                        // should do nothing...no function be added!

                    } else if (_.isObject(source[property]) && !_.isDate(source[property])) {
                        object[property] = updateObject(destination[property], source[property], isStrictMode);

                        processed.push({ value: source[property], newValue: object[property] });

                    } else {
                        object[property] = source[property];
                    }
            }

            clearObject(destination);
            _.assign(destination, object);

            return destination;
        }

        function updateArray(destination, source, isStrictMode) {
            if (!destination) {
                return source;
            }
            var array = [];
            source.forEach(function (item) {

                var processedData = findProcessed(item);
                if (processedData) {
                    array.push(processedData);
                } else

                    // does not try to maintain object references in arrays
                    // super loose mode.
                    if (isStrictMode === 'NONE') {
                        array.push(item);
                    } else {
                        // object in array must have an id otherwise we can't maintain the instance reference
                        if (!_.isArray(item) && _.isObject(item)) {
                            // let try to find the instance
                            if (angular.isDefined(item.id)) {
                                array.push(updateObject(_.find(destination, function (obj) {
                                    return obj.id.toString() === item.id.toString();
                                }), item, isStrictMode));
                            } else {
                                if (isStrictMode) {
                                    throw new Error('objects in array must have an id otherwise we can\'t maintain the instance reference. ' + JSON.stringify(item));
                                }
                                array.push(item);
                            }
                        } else {
                            array.push(item);
                        }
                    }
            });

            destination.length = 0;
            Array.prototype.push.apply(destination, array);
            //angular.copy(destination, array);
            return destination;
        }
    }
    function clearObject(object) {
        Object.keys(object).forEach(function (key) { delete object[key]; });
    }
};

