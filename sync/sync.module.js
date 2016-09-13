angular
    .module('sync', ['socketio-auth'])
    .config(function($socketioProvider){
        $socketioProvider.setDebug(true);
    });
