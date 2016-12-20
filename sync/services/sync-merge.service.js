
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


        function findObjectReference(value) {
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

            // let's say we sync on person
            // person has parentId
            // but thru dress we replace parentId py parent and store the parent object

            // we do not need to merge parent because it has a revision number
            // dress that happens during setOnReady, will set the parent object based on the parentId




            // create new object containing only the properties of source merge with destination
            var newValue, object = {};
            for (var property in source) {
                var reference = findObjectReference(source[property]);

                //Object.getOwnPropertyDescriptor                
                var d = Object.getOwnPropertyDescriptor(source, property);
                if (d && (d.set || d.get)) {
                    // do nothing, it is computed

                } else if (reference) {
                    // if the object in the source was already processed,
                    // let's use the reference
                    object[property] = reference;//destination[property];

                } else if (_.isArray(source[property])) {

                    // if an array is multiple time references in the source
                    // make sure we will also reference multiple time the same object in the destination
                    if (destination[property]) {
                        processed.push({ value: source[property], newValue: destination[property] });
                        object[property] = updateArray(destination[property], source[property], isStrictMode);
                    } else {
                        processed.push({ value: source[property], newValue: source[property] });
                        object[property] = source[property];
                    }


                } else if (_.isFunction(source[property])) {
                    // Function are not merged. Do nothing.

                } else if (_.isObject(source[property]) && !_.isDate(source[property])) {
                    if (destination[property]) {
                        // the related object exists in the destination,
                        // let's update it.
                        // 
                        // so next time, a source property deals with this object, there will be no need to merge it.
                        processed.push({ value: source[property], newValue: destination[property] });
                        object[property] = updateObject(destination[property], source[property], isStrictMode);
                    } else {
                        processed.push({ value: source[property], newValue: source[property] });
                        object[property] = source[property];
                    }

                } else {
                    // a basic property value is just copied.
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

                var processedReference = findObjectReference(item);
                if (processedReference) {
                    // if an object is already referenced, let's use the same reference;
                    array.push(processedReference);
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
                                var dest = _.find(destination, function (obj) {
                                    return obj.id.toString() === item.id.toString();
                                });

                                // save reference to an object for reuse;                                
                                processed.push({ value: item, newValue: dest });                                

                                array.push(updateObject(dest, item, isStrictMode));
                                
                            } else {
                                if (isStrictMode) {
                                    throw new Error('objects in array must have an id otherwise we can\'t maintain the instance reference. ' + stringify(item));
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

    function stringify(obj) {
        try {
            return JSON.stringify(obj);
        }
        catch (err) {
            return 'Object has cyclic structure.';
        }
    }
};

