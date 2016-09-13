//////////////////////////////////////////////
// Modules
//////////////////////////////////////////////

// the main gulp reference
var gulp = require('gulp');

// deletes files used during build (https://www.npmjs.com/package/gulp-clean)
var clean = require('gulp-clean');

// combines files into a single destination file (https://github.com/wearefractal/gulp-concat)
var concat = require('gulp-concat');

// angular.js annotation for compression (https://www.npmjs.com/package/gulp-ng-annotate)
var annotate = require('gulp-ng-annotate');

// minification and variable/parameter renaming (https://www.npmjs.com/package/gulp-uglify)
var uglify = require('gulp-uglify');

// add an IIFE to each file () 
var iife = require("gulp-iife");

// just prints a filesize of a file (https://www.npmjs.com/package/gulp-filesize)
var filesize = require('gulp-filesize');

// watches files for changes and reruns tasks (https://www.npmjs.com/package/gulp-watch)
var watch = require('gulp-watch');

// remove debug statements in the app code (https://www.npmjs.com/package/gulp-strip-debug)
var stripDebug = require('gulp-strip-debug');

// karma server to run automated unit tests (http://karma-runner.github.io/0.13/index.html)
var Server = require('karma').Server;

// jscs JS Code Style checker.  (http://jscs.info)
var jscs = require('gulp-jscs');

// sourcemaps (https://www.npmjs.com/package/gulp-sourcemaps)
var sourcemaps = require('gulp-sourcemaps');

// gulp-bump (https://www.npmjs.com/package/gulp-bump)
var bump = require('gulp-bump');

// git-describe (https://www.npmjs.com/package/git-describe)
var gitDescribe = require('git-describe');

// used for css pre-processing
var sass = require('gulp-sass');

// used for renaming the css style output to "build.css"
var rename = require('gulp-rename');

// used for generating font files from svg icons
var iconfont = require('gulp-iconfont');

// used by gulp-iconfont
var consolidate = require('gulp-consolidate');

//////////////////////////////////////////////
// Variables
//////////////////////////////////////////////

// All application JS files.
var appFiles = [
//'api/models/**/*.model.js',
    'sync/**/*.js'];

//////////////////////////////////////////////
// Tasks
//////////////////////////////////////////////

// perform a variety of operations on our app js files
// todo: need to make a change to handle for production properly
gulp.task('app-js', ['iife-build-prod'], function (done) {
    // model is not iife
    var src = ['build/app-iife.js'];
    return gulp.src(src)
        .pipe(concat('angular-sync.min.js'))
        .pipe(stripDebug())
        .pipe(annotate())
        .pipe(uglify())  
        .pipe(filesize())
        .pipe(gulp.dest('dist/'));
});

// wrap all angular code in bracket and add useStrict in prod
gulp.task('iife-build-prod', function () {
    return gulp.src(appFiles)
        .pipe(iife({
            useStrict: true,
            trimCode: true,
            prependSemicolon: false,
            bindThis: false
        }))
        .pipe(concat('app-iife.js'))
        .pipe(gulp.dest('build/'));

});

// perform a variety of operations on our app js files
gulp.task('app-js-dev', ['iife-build-dev'], function () {
    // model is not iife
    var src = ['build/app-iife.js'];
    //var src = appFiles.concat(genFiles);
    return gulp.src(src)
    // so that we load the source map in iife-build
        .pipe(sourcemaps.init({ loadMaps: true }))
        .pipe(concat('angular-sync.js'))
        .pipe(annotate())
        .pipe(filesize())
        .pipe(sourcemaps.write())
        .pipe(gulp.dest('dist/'));
});

// wrap all angular code in bracket and add useStrict, and add sourcemap in dev
gulp.task('iife-build-dev', function () {

    return gulp.src(appFiles)
        .pipe(sourcemaps.init())
        .pipe(iife({
            useStrict: true,
            trimCode: true,
            prependSemicolon: false,
            bindThis: false
        }))
        .pipe(concat('app-iife.js'))
        
        // .pipe(annotate())
        // .pipe(filesize())        
        .pipe(sourcemaps.write())
        .pipe(gulp.dest('build/'));
});

// single run testing
gulp.task('test', function (done) {
    new Server({ configFile: __dirname + '/karma.conf.js', singleRun: true }, 
        function(code) {
            if (code == 1){
                console.log('Unit Test failures, exiting process');
                //done(new Error(`Karma exited with status code ${code}`));
                return process.exit(code);
            } else {
                console.log('Unit Tests passed');
                done();
            }    
        }).start();
});

// continuous testing
gulp.task('tdd', function (done) {
    new Server({ configFile: __dirname + '/karma.conf.js' }, function() {
        done();
    }).start();
});

// watch the app .js files for changes and execute the app-js task if necessary
gulp.task('app-watch', function () {
    watch(appFiles, function (file) {
        gulp.start('app-js-dev');
    });
});

// clean up files after builds
gulp.task('cleanup', function () {
    return gulp.src('build', {read: false})
		.pipe(clean());
});

// bump the dev version (NOTE: NOT IN USE RIGHT NOW)
gulp.task('bump-dev', function () {
    var gitInfo = gitDescribe(__dirname);

    gulp.src(['./bower.json', './package.json'])
        .pipe(bump({ type: 'prerelease', preid: gitInfo.hash }))
        .pipe(gulp.dest('./'));
});

// build angular-socketio.js for dev (with map) and prod (min)
gulp.task('build', ['app-js-dev','app-js'], function () {
        gulp.start([ 'test','cleanup']);
});


// continuous watchers
gulp.task('default', ['app-js-dev','app-js'], function () {
    gulp.start([ 'app-watch', 'tdd']);
});



