 /*
 * Copyright (c) 2013 Adobe Systems Incorporated. All rights reserved.
 *  
 * Permission is hereby granted, free of charge, to any person obtaining a
 * copy of this software and associated documentation files (the "Software"), 
 * to deal in the Software without restriction, including without limitation 
 * the rights to use, copy, modify, merge, publish, distribute, sublicense, 
 * and/or sell copies of the Software, and to permit persons to whom the 
 * Software is furnished to do so, subject to the following conditions:
 *  
 * The above copyright notice and this permission notice shall be included in
 * all copies or substantial portions of the Software.
 *  
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, 
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER 
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING 
 * FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER 
 * DEALINGS IN THE SOFTWARE.
 * 
 */


/*jslint vars: true, plusplus: true, devel: true, nomen: true, indent: 4, maxerr: 50 */
/*global define, $, FileReader*/

define(function (require, exports, module) {
    "use strict";
   
    var Async           = require("utils/Async"),
        CommandManager  = require("command/CommandManager"),
        Commands        = require("command/Commands"),
        Dialogs         = require("widgets/Dialogs"),
        DefaultDialogs  = require("widgets/DefaultDialogs"),
        MainViewManager = require("view/MainViewManager"),
        FileSystem      = require("filesystem/FileSystem"),
        FileUtils       = require("file/FileUtils"),
        ProjectManager  = require("project/ProjectManager"),
        Strings         = require("strings"),
        StringUtils     = require("utils/StringUtils");

    // Bramble specific bits
    var _               = require("thirdparty/lodash"),
        Filer           = require("filesystem/impls/filer/BracketsFiler"),
        Path            = Filer.Path,
        Content         = require("filesystem/impls/filer/lib/content"),
        LanguageManager = require("language/LanguageManager");

    // 3M size limit for imported files
    var byteLimit = 3 * 1024 * 1000;

    /**
     * Returns true if the drag and drop items contains valid drop objects.
     * @param {Array.<DataTransferItem>} items Array of items being dragged
     * @return {boolean} True if one or more items can be dropped.
     */
    function isValidDrop(types) {
        if (types) {
            for (var i = 0; i < types.length; i++) {
                if (types[i] === "Files") {
                    return true;
                }

            }
        }
        return false;
    }

    function _showErrorDialog(errorFiles) {
        function errorToString(err) {
            return FileUtils.getFileErrorString(err);
        }

        if (!errorFiles.length) {
            return;
        }

        var message = Strings.ERROR_OPENING_FILES;
        
        message += "<ul class='dialog-list'>";
        errorFiles.forEach(function (info) {
            message += "<li><span class='dialog-filename'>" +
                StringUtils.breakableUrl(ProjectManager.makeProjectRelativeIfPossible(info.path)) +
                "</span> - " + errorToString(info.error) +
                "</li>";
        });
        message += "</ul>";

        Dialogs.showModalDialog(
            DefaultDialogs.DIALOG_ID_ERROR,
            Strings.ERROR_OPENING_FILE_TITLE,
            message
        );
    }

    /**
     * Open dropped files
     * @param {Array.<string>} files Array of files dropped on the application.
     * @return {Promise} Promise that is resolved if all files are opened, or rejected
     *     if there was an error. 
     */
    function openDroppedFiles(paths) {
        var errorFiles = [],
            ERR_MULTIPLE_ITEMS_WITH_DIR = {};
        
        return Async.doInParallel(paths, function (path, idx) {
            var result = new $.Deferred();
            
            // Only open files.
            FileSystem.resolve(path, function (err, item) {
                if (!err && item.isFile) {
                    // If the file is already open, and this isn't the last
                    // file in the list, return. If this *is* the last file,
                    // always open it so it gets selected.
                    if (idx < paths.length - 1) {
                        if (MainViewManager.findInWorkingSet(MainViewManager.ALL_PANES, path) !== -1) {
                            result.resolve();
                            return;
                        }
                    }
                    
                    CommandManager.execute(Commands.CMD_ADD_TO_WORKINGSET_AND_OPEN,
                                           {fullPath: path, silent: true})
                        .done(function () {
                            result.resolve();
                        })
                        .fail(function (openErr) {
                            errorFiles.push({path: path, error: openErr});
                            result.reject();
                        });
                } else if (!err && item.isDirectory && paths.length === 1) {
                    // One folder was dropped, open it.
                    ProjectManager.openProject(path)
                        .done(function () {
                            result.resolve();
                        })
                        .fail(function () {
                            // User was already notified of the error.
                            result.reject();
                        });
                } else {
                    errorFiles.push({path: path, error: err || ERR_MULTIPLE_ITEMS_WITH_DIR});
                    result.reject();
                }
            });
            
            return result.promise();
        }, false)
            .fail(function () {
                _showErrorDialog(errorFiles);
            });
    }
    
    
    /**
     * Attaches global drag & drop handlers to this window. This enables dropping files/folders to open them, and also
     * protects the Brackets app from being replaced by the browser trying to load the dropped file in its place.
     */
    function attachHandlers() {

        function handleDragOver(event) {
            event = event.originalEvent || event;
            event.stopPropagation();
            event.preventDefault();

            var dropEffect =  "none";
            // Don't allow drag-and-drop of files/folders when a modal dialog is showing.
            if ($(".modal.instance").length === 0 && isValidDrop(event.dataTransfer.types)) {
                dropEffect = "copy";
            }
            event.dataTransfer.dropEffect = dropEffect;
        }

        function handleDrop(event) {
            event = event.originalEvent || event;
            event.stopPropagation();
            event.preventDefault();

            var pathList = [];
            var errorList = [];

            function prepareDropPaths(fileList) {
                // Convert FileList object to an Array with all image files first, then CSS
                // followed by HTML files at the end, since we need to write any .css, .js, etc.
                // resources first such that Blob URLs can be generated for these resources
                // prior to rewriting an HTML file.
                function rateFileByType(filename) {
                    var ext = Path.extname(filename);

                    // We want to end up with: [images, ..., js, ..., css, html]
                    // since CSS can include images, and HTML can include CSS or JS.
                    // We also treat .md like an HTML file, since we render them.
                    if(Content.isHTML(ext) || Content.isMarkdown(ext)) {
                        return 10;
                    } else if(Content.isCSS(ext)) {
                        return 8;
                    } else if(Content.isImage(ext)) {
                        return 1;
                    }
                    return 3;
                }

                return _.toArray(fileList).sort(function(a,b) {
                    a = rateFileByType(a.name);
                    b = rateFileByType(b.name);

                    if(a < b) {
                        return -1;
                    }
                    if(a > b) {
                        return 1;
                    }
                    return 0;
                });
            }

            /**
             * Determine whether we want to import this file at all.  If it's too large
             * or not a mime type we care about, reject it.
             */
            function rejectImport(item) {
                if (item.size > byteLimit) {
                    return new Error("file exceeds maximum supported size");
                }

                // If we don't know about this language type, or the OS doesn't think
                // it's text, reject it.
                var ext = Path.extname(item.name).replace(/^\./, "");
                var languageIsSupported = !!LanguageManager.getLanguageForExtension(ext);
                var typeIsText = Content.isTextType(item.type);

                if (languageIsSupported || typeIsText) {
                    return null;
                }
                return new Error("unsupported file type");
            }

            function maybeImportFile(item) {
                var deferred = new $.Deferred();
                var reader = new FileReader();

                // Check whether we want to import this file at all before we start.
                var wasRejected = rejectImport(item);
                if (wasRejected) {
                    setTimeout(function(){
                        errorList.push({path: item.name, error: wasRejected.message});
                        deferred.reject(wasRejected);
                    }, 5);
                    return deferred.promise();
                }

                reader.onload = function(e) {
                    delete reader.onload;

                    var filename = Path.join('/', item.name);
                    var file = FileSystem.getFileForPath(filename);

                    // Create a Filer Buffer, and determine the proper encoding. We
                    // use the extension, and also the OS provided mime type for clues.
                    var buffer = new Filer.Buffer(e.target.result);
                    var utf8FromExt = Content.isUTF8Encoded(Path.extname(filename));
                    var utf8FromOS = Content.isTextType(item.type);
                    var encoding =  utf8FromExt || utf8FromOS ? 'utf8' : null;
                    if(encoding === 'utf8') {
                        buffer = buffer.toString();
                    }

                    file.write(buffer, {encoding: encoding}, function(err) {
                        if (err) {
                            deferred.reject(err);
                            return;
                        }

                        pathList.push(filename);
                        deferred.resolve();
                    });
                };

                // Deal with error cases, for example, trying to drop a folder vs. file
                reader.onerror = function(e) {
                    delete reader.onerror;

                    errorList.push({path: item.name, error: e.target.error.message});
                    deferred.reject(e.target.error);
                };
                reader.readAsArrayBuffer(item);

                return deferred.promise();
            }

            var files = event.dataTransfer.files;

            if (files && files.length) {
                Async.doSequentially(prepareDropPaths(files), maybeImportFile, false)
                    .done(function() {
                        openDroppedFiles(pathList);
                    })
                    .fail(function() {
                        _showErrorDialog(errorList);
                    });
            }
        }
        
        // For most of the window, only respond if nothing more specific in the UI has already grabbed the event (e.g.
        // the Extension Manager drop-to-install zone, or an extension with a drop-to-upload zone in its panel)
        $(window.document.body)
            .on("dragover", handleDragOver)
            .on("drop", handleDrop);
        
        // Over CodeMirror specifically, always pre-empt CodeMirror's drag event handling if files are being dragged - CM stops
        // propagation on any drag event it sees, even when it's not a text drag/drop. But allow CM to handle all non-file drag
        // events. See bug #10617.
        window.document.body.addEventListener("dragover", function (event) {
            if ($(event.target).closest(".CodeMirror").length) {
                handleDragOver(event);
            }
        }, true);
        window.document.body.addEventListener("drop", function (event) {
            if ($(event.target).closest(".CodeMirror").length) {
                handleDrop(event);
            }
        }, true);
    }
    
    
    CommandManager.register(Strings.CMD_OPEN_DROPPED_FILES, Commands.FILE_OPEN_DROPPED_FILES, openDroppedFiles);

    // Export public API
    exports.attachHandlers      = attachHandlers;
    exports.isValidDrop         = isValidDrop;
    exports.openDroppedFiles    = openDroppedFiles;
});
