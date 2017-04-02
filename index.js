/* eslint-env node */
'use strict';

var path = require('path');
var fs = require('fs');

var EventEmitter = require('events').EventEmitter;
var mergeTrees = require('broccoli-merge-trees');
var VersionChecker = require('ember-cli-version-checker');
var FastBootExpressMiddleware = require('fastboot-express-middleware');
var FastBoot = require('fastboot');
var chalk = require('chalk');

var fastbootAppModule = require('./lib/utilities/fastboot-app-module');
var FastBootConfig      = require('./lib/broccoli/fastboot-config');

const Funnel = require('broccoli-funnel');
const Concat = require('broccoli-concat');
const p = require('ember-cli-preprocess-registry/preprocessors');
const existsSync = require('exists-sync');

/*
 * Main entrypoint for the Ember CLI addon.
 */
module.exports = {
  name: 'ember-cli-fastboot',

  // TODO remove once serve PR is checked in
  init() {
    this._super.init && this._super.init.apply(this, arguments);

    this.emitter = new EventEmitter();
  },

  // TODO remove once serve PR is checked in
  includedCommands: function() {
    return {
      'fastboot':       require('./lib/commands/fastboot')(this),
    };
  },

  // TODO remove once serve PR is checked in
  on: function() {
    this.emitter.on.apply(this.emitter, arguments);
  },

  // TODO remove once serve PR is checked in
  emit: function() {
    this.emitter.emit.apply(this.emitter, arguments);
  },

  /**
   * Called at the start of the build process to let the addon know it will be
   * used. Sets the auto run on app to be false so that we create and route app
   * automatically only in browser.
   *
   * See: https://ember-cli.com/user-guide/#integration
   */
  included: function(app) {
    // set autoRun to false since we will conditionally include creating app when app files
    // is eval'd in app-boot
    app.options.autoRun = false;
    // get the app registry object and app name so that we can build the fastboot
    // tree
    this._appRegistry = app.registry;
    this._name = app.name;
  },

  /**
   * Inserts placeholders into index.html that are used by the FastBoot server
   * to insert the rendered content into the right spot. Also injects a module
   * for FastBoot application boot.
   */
  contentFor: function(type, config, contents) {
    if (type === 'body') {
      return "<!-- EMBER_CLI_FASTBOOT_BODY -->";
    }

    if (type === 'head') {
      return "<!-- EMBER_CLI_FASTBOOT_TITLE --><!-- EMBER_CLI_FASTBOOT_HEAD -->";
    }

    if (type === 'app-boot') {
      return fastbootAppModule(config.modulePrefix, JSON.stringify(config.APP || {}));
    }

    // if the fastboot addon is installed, we overwrite the config-module so that the config can be read
    // from meta tag for browser build and from Fastboot config for fastboot target
    if (type === 'config-module') {
      var emberCliPath = path.join(this.app.project.nodeModulesPath, 'ember-cli');
      contents.splice(0, contents.length);
      contents.push('if (typeof FastBoot !== \'undefined\') {');
      contents.push('return FastBoot.config();');
      contents.push('} else {');
      contents.push('var prefix = \'' + config.modulePrefix + '\';');
      contents.push(fs.readFileSync(path.join(emberCliPath, 'lib/broccoli/app-config-from-meta.js')));
      contents.push('}');
      return;
    }
  },

  /**
   * Function that builds the fastboot tree from all fastboot complaint addons
   * and project and transpiles it into appname-fastboot.js
   */
  _getFastbootTree: function() {
    var appName = this._name;
    var nodeModulesPath = this.project.nodeModulesPath;

    var fastbootTrees = [];
    this.project.addons.forEach((addon) => {
      // walk through each addon and grab its fastboot tree
      var currentAddonFastbootPath = path.join(nodeModulesPath, addon.name, 'fastboot');
      // TODO: throw a warning if app/iniitalizer/[browser|fastboot] exists

      if (existsSync(currentAddonFastbootPath)) {
        var fastbootTree = new Funnel(currentAddonFastbootPath, {
          destDir: appName
        });

        fastbootTrees.push(fastbootTree);
      }
    });

    // check the parent containing the fastboot directory
    var projectFastbootPath = path.join(this.project.root, 'fastboot');
    if (existsSync(projectFastbootPath)) {
      var fastbootTree = new Funnel(projectFastbootPath, {
        destDir: appName
      });

      fastbootTrees.push(fastbootTree);
    }

    // check the ember-cli version and conditionally patch the DOM api
    if (this._getEmberVersion().lt('2.10.0-alpha.1')) {
      var fastbootTree = new Funnel(path.resolve(__dirname, 'fastboot-app-lt-2-9'), {
        destDir: appName
      });

      fastbootTrees.push(fastbootTree);
    }

    var fastbootTree = new mergeTrees(fastbootTrees);

    // transpile the fastboot JS tree
    var processExtraTree = p.preprocessJs(fastbootTree, '/', this._name, {
      registry: this._appRegistry
    });

    var fileAppName = path.basename(this.app.options.outputPaths.app.js).split('.')[0];
    var finalFastbootTree = Concat(processExtraTree, {
      outputFile: 'assets/' + fileAppName + '-fastboot.js'
    });

    return finalFastbootTree;
  },

  treeForPublic(tree) {
    let fastbootTree = this._getFastbootTree();
    let trees = [];
    if (tree) {
      trees.push(tree);
    }
    trees.push(fastbootTree);

    let newTree = new mergeTrees(trees);

    return newTree;
  },

  /**
   * After the entire Broccoli tree has been built for the `dist` directory,
   * adds the `fastboot-config.json` file to the root.
   *
   */
  postprocessTree: function(type, tree) {
    if (type === 'all') {
      var fastbootConfigTree = this._buildFastbootConfigTree(tree);

      // Merge the package.json with the existing tree
      return mergeTrees([tree, fastbootConfigTree], {overwrite: true});
    }

    return tree;
  },

  _buildFastbootConfigTree : function(tree) {
    var env = this.app.env;
    var config = this.project.config(env);
    var fastbootConfig = config.fastboot;
    // do not boot the app automatically in fastboot. The instance is booted and
    // lives for the lifetime of the request.
    if (config.hasOwnProperty('APP')) {
      config['APP']['autoboot'] = false;
    } else {
      config['APP'] = {
        'autoboot': false
      }
    }

    return new FastBootConfig(tree, {
      assetMapPath: this.assetMapPath,
      project: this.project,
      name: this.app.name,
      outputPaths: this.app.options.outputPaths,
      ui: this.ui,
      fastbootAppConfig: fastbootConfig,
      appConfig: config
    });
  },

  serverMiddleware: function(options) {
    var emberCliVersion = this._getEmberCliVersion();
    var app = options.app;
    var options = options.options;

    if (emberCliVersion.satisfies('>= 2.12.0-beta.1')) {
      // only run the middleware when ember-cli version for app is above 2.12.0-beta.1 since
      // that version contains API to hook fastboot into ember-cli

      app.use((req, resp, next) => {
        var fastbootQueryParam = (req.query.hasOwnProperty('fastboot') && req.query.fastboot === 'false') ? false : true;
        var enableFastBootServe = !process.env.FASTBOOT_DISABLED && fastbootQueryParam;
        var broccoliHeader = req.headers['x-broccoli'];
        var outputPath = broccoliHeader['outputPath'];

        if (broccoliHeader['url'] === req.serveUrl && enableFastBootServe) {
          // if it is a base page request, then have fastboot serve the base page
          if (!this.fastboot) {
            // TODO(future): make this configurable for allowing apps to pass sandboxGlobals
            // and custom sandbox class
            this.ui.writeLine(chalk.green('App is being served by FastBoot'));
            this.fastboot = new FastBoot({
              distPath: outputPath
            });
          }

          var fastbootMiddleware = FastBootExpressMiddleware({
            fastboot: this.fastboot
          });

          fastbootMiddleware(req, resp, next);
        } else {
          // forward the request to the next middleware (example other assets, proxy etc)
          next();
        }
      })
    }
  },

  // TODO remove once serve PR is checked in
  outputReady: function() {
    this.emit('outputReady');
  },

  // TODO remove once serve PR is checked in
  postBuild: function() {
    this.emit('postBuild');
    if (this.fastboot) {
      // should we reload fastboot if there are only css changes? Seems it maynot be needed.
      // TODO(future): we can do a smarter reload here by running fs-tree-diff on files loaded
      // in sandbox.
      this.ui.writeLine(chalk.blue('Reloading FastBoot...'));
      this.fastboot.reload({
        distPath: result.directory
      });
    }
  },

  _getEmberCliVersion: function() {
    var VersionChecker = require('ember-cli-version-checker');
    var checker = new VersionChecker(this);

    return checker.for('ember-cli', 'npm');
  },

  _getEmberVersion: function() {
    var VersionChecker = require('ember-cli-version-checker');
    var checker = new VersionChecker(this);
    var emberVersionChecker = checker.for('ember-source', 'npm');

    if (emberVersionChecker.version) {
      return emberVersionChecker;
    }

    return checker.for('ember', 'bower');
  },
};
