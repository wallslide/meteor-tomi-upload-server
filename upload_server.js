var formidable = Npm.require('formidable');
var http = Npm.require('http');
var sys = Npm.require('sys');
var connect = Npm.require('connect');
var path = Npm.require('path');
var fs = Npm.require('fs');

var _existsSync = fs.existsSync || path.existsSync;
var imageMagick = Npm.require('imagemagick');

var  options = {
  /** @type String*/
  tmpDir: null,
  /** @type String*/
  uploadDir: null,
  uploadUrl: '/upload/',
  maxPostSize: 11000000000, // 11 GB
  minFileSize: 1,
  maxFileSize: 10000000000, // 10 GB
  acceptFileTypes: /.+/i,
  // Files not matched by this regular expression force a download dialog,
  // to prevent executing any scripts in the context of the service domain:
  inlineFileTypes: /\.(gif|jpe?g|png)$/i,
  imageTypes: /\.(gif|jpe?g|png)$/i,
  imageVersions: {
    'thumbnail': {
      width: 200,
      height: 200
    }
  },
  getDirectory: function(file, formData) { return "" },
  getFileName: function(file, formData) { return file; },
  finished: function() {},
  accessControl: {
    allowOrigin: '*',
    allowMethods: 'OPTIONS, HEAD, GET, POST, PUT, DELETE',
    allowHeaders: 'Content-Type, Content-Range, Content-Disposition'
  }
  /* Uncomment and edit this section to provide the service via HTTPS:
   ssl: {
   key: fs.readFileSync('/Applications/XAMPP/etc/ssl.key/server.key'),
   cert: fs.readFileSync('/Applications/XAMPP/etc/ssl.crt/server.crt')
   },
   */
};


UploadServer = {
  init: function(opts) {
    if (opts.tmpDir == null) {
      throw new Meteor.Error('Temporary directory needs to be assigned!');
    } else {
      options.tmpDir = opts.tmpDir;
    }

    if (opts.uploadDir == null) {
      throw new Meteor.Error('Upload directory needs to be assigned!');
    } else {
      options.uploadDir = opts.uploadDir;
    }

    if (opts.maxPostSize != null) options.maxPostSize = opts.maxPostSize;
    if (opts.minFileSize != null) options.minFileSize = opts.maxPostSize;
    if (opts.maxFileSize != null) options.maxFileSize = opts.maxFileSize;
    if (opts.acceptFileTypes != null) options.acceptFileTypes = opts.acceptFileTypes;
    if (opts.imageTypes != null) options.imageTypes = opts.imageTypes;
    if (opts.getDirectory != null) options.getDirectory = opts.getDirectory;
    if (opts.getFileName != null) options.getFileName = opts.getFileName;
    if (opts.finished != null) options.finished = opts.finished;

    if (opts.uploadUrl) options.uploadUrl = opts.uploadUrl;

    if (opts.imageVersions != null) options.imageVersions = opts.imageVersions
    else options.imageVersions = [];
  },
  serve: function (req, res) {
    if (options.tmpDir == null || options.uploadDir == null) {
      throw new Meteor.Error('Upload component not initialised!');
    }

    res.setHeader(
      'Access-Control-Allow-Origin',
      options.accessControl.allowOrigin
    );
    res.setHeader(
      'Access-Control-Allow-Methods',
      options.accessControl.allowMethods
    );
    res.setHeader(
      'Access-Control-Allow-Headers',
      options.accessControl.allowHeaders
    );
    var handleResult = function (result, redirect) {
        if (redirect) {
          res.writeHead(302, {
            'Location': redirect.replace(
              /%s/,
              encodeURIComponent(JSON.stringify(result))
            )
          });
          res.end();
        } else {
          res.writeHead(200, {
            'Content-Type': req.headers.accept
              .indexOf('application/json') !== -1 ?
              'application/json' : 'text/plain'
          });
          res.end(JSON.stringify(result));
        }
      },
      setNoCacheHeaders = function () {
        res.setHeader('Pragma', 'no-cache');
        res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
        res.setHeader('Content-Disposition', 'inline; filename="files.json"');
      },
      handler = new UploadHandler(req, res, handleResult);

    switch (req.method) {
      case 'OPTIONS':
        res.end();
        break;
      case 'HEAD':
      case 'GET':
        setNoCacheHeaders();
        // TODO: Make safe url
        connect.static(options.uploadDir)(req, res);
        break;
      case 'POST':
        setNoCacheHeaders();
        handler.post();
        break;
      //case 'DELETE':
      //  handler.destroy();
      //  break;
      default:
        res.statusCode = 405;
        res.end();
    }
  }
}

var utf8encode = function (str) {
    return unescape(encodeURIComponent(str));
  };

var nameCountRegexp = /(?:(?: \(([\d]+)\))?(\.[^.]+))?$/;

var nameCountFunc = function (s, index, ext) {
    return ' (' + ((parseInt(index, 10) || 0) + 1) + ')' + (ext || '');
  };

var FileInfo = function (file) {
    this.name = file.name;
    this.size = file.size;
    this.type = file.type;
  };

var UploadHandler = function (req, res, callback) {
    this.req = req;
    this.res = res;
    this.callback = callback;
};

FileInfo.prototype.validate = function () {
  if (options.minFileSize && options.minFileSize > this.size) {
    this.error = 'File is too small';
  } else if (options.maxFileSize && options.maxFileSize < this.size) {
    this.error = 'File is too big';
  } else if (!options.acceptFileTypes.test(this.name)) {
    this.error = 'Filetype not allowed';
  }
  return !this.error;
};

FileInfo.prototype.safeName = function () {
  // Prevent directory traversal and creating hidden system files:
  this.name = path.basename(this.name).replace(/^\.+/, '');
  // Prevent overwriting existing files:
  while (_existsSync(options.uploadDir + '/' + this.name)) {
    this.name = this.name.replace(nameCountRegexp, nameCountFunc);
  }
};

FileInfo.prototype.initUrls = function (req, form) {
  if (!this.error) {
    var that = this,
      subDirectory = options.getDirectory(this.name, form.formFields),
      baseUrl = (options.ssl ? 'https:' : 'http:') +
        '//' + req.headers.host + options.uploadUrl;
    this.url = baseUrl + (subDirectory ? (subDirectory + '/') : '') + encodeURIComponent(this.name);
    Object.keys(options.imageVersions).forEach(function (version) {
      if (_existsSync(
          options.uploadDir + '/' + version + '/' + that.name
        )) {
        that[version + 'Url'] = baseUrl + version + '/' +
        encodeURIComponent(that.name);
      }
    });
  }
};

UploadHandler.prototype.post = function () {
  var handler = this,
    form = new formidable.IncomingForm(),
    tmpFiles = [],
    files = [],
    map = {},
    counter = 1,
    redirect,
    finish = function () {
      counter -= 1;
      if (!counter) {
        files.forEach(function (fileInfo) {
          fileInfo.initUrls(handler.req, form);
        });
        handler.callback({files: files}, redirect);
      }
    };
  form.uploadDir = options.tmpDir;
  form.on('fileBegin', function (name, file) {
    tmpFiles.push(file.path);
    var fileInfo = new FileInfo(file, handler.req, true);
    fileInfo.safeName();
    map[path.basename(file.path)] = fileInfo;
    files.push(fileInfo);
  }).on('field', function (name, value) {
    if (name === 'redirect') {
      redirect = value;
    }
    // remember all the form fields
    if (this.formFields == null) {
      this.formFields = {};
    }
    this.formFields[name] = value;
  }).on('file', function (name, file) {
    //var fileInfo = map[path.basename(file.path)];
    //fileInfo.size = file.size;
    //if (!fileInfo.validate()) {
    //  fs.unlink(file.path);
    //  return;
    //}
    //
    //// we can store files in subdirectories
    //var folder = options.getDirectory(fileInfo.name, this.formFields);
    //// check if directory exists, if not, create all the directories
    //var subFolders = folder.split('/');
    //var currentFolder = options.uploadDir;
    //for (var i = 0; i < subFolders.length; i++) {
    //  currentFolder += '/' + subFolders[i];
    //
    //  if (!fs.existsSync(currentFolder)) {
    //    fs.mkdirSync(currentFolder);
    //  }
    //}
    //
    //// possibly rename file if needed;
    //var newFileName = options.getFileName(fileInfo.name, this.formFields);
    //
    //// set the file name
    //fileInfo.path = folder + "/" + newFileName;
    //
    //fs.renameSync(file.path, currentFolder + "/" + newFileName);
    //
    //if (options.imageTypes.test(fileInfo.name)) {
    //  Object.keys(options.imageVersions).forEach(function (version) {
    //    counter += 1;
    //    var opts = options.imageVersions[version];
    //
    //    // check if version directory exists
    //    if (!fs.existsSync(currentFolder + '/' + version)) {
    //      fs.mkdirSync(currentFolder + '/' + version);
    //    }
    //
    //    imageMagick.resize({
    //      width: opts.width,
    //      height: opts.height,
    //      srcPath: currentFolder + '/' + newFileName,
    //      dstPath: currentFolder + '/' + version + '/' + newFileName
    //    }, finish);
    //  });
    //}
    //
    //// call the feedback
    options.finished(file, this.formFields);
  }).on('aborted', function () {
    tmpFiles.forEach(function (file) {
      fs.unlink(file);
    });
  }).on('error', function (e) {
    console.log(e);
  }).on('progress', function (bytesReceived, bytesExpected) {
    if (bytesReceived > options.maxPostSize) {
      handler.req.connection.destroy();
    }
  }).on('end', finish).parse(handler.req);
};

UploadHandler.prototype.destroy = function () {
  var handler = this,
    fileName;
  if (handler.req.url.slice(0, options.uploadUrl.length) === options.uploadUrl) {
    fileName = path.basename(decodeURIComponent(handler.req.url));
    if (fileName[0] !== '.') {
      fs.unlink(options.uploadDir + '/' + fileName, function (ex) {
        Object.keys(options.imageVersions).forEach(function (version) {
          fs.unlink(options.uploadDir + '/' + version + '/' + fileName);
        });
        handler.callback({success: !ex});
      });
      return;
    }
  }
  handler.callback({success: false});
};

// declare routes

RoutePolicy.declare(options.uploadUrl, 'network');
WebApp.connectHandlers.use(options.uploadUrl, UploadServer.serve);

