/* eslint-env node */
'use strict';

var path = require('path');

var EventEmitter = require('events').EventEmitter;
var mergeTrees = require('broccoli-merge-trees');
var VersionChecker = require('ember-cli-version-checker');

var patchEmberApp     = require('./lib/ext/patch-ember-app');
var fastbootAppModule = require('./lib/utilities/fastboot-app-module');

var filterInitializers = require('fastboot-filter-initializers');
var FastBootBuild      = require('./lib/broccoli/fastboot-build');

const BroccoliMergeTrees = require('broccoli-merge-trees');
const Funnel = require('broccoli-funnel');
const Concat = require('broccoli-concat');
const p = require('ember-cli-preprocess-registry/preprocessors');
const existsSync = require('exists-sync');

/*
 * Main entrypoint for the Ember CLI addon.
 */

module.exports = {
  name: 'ember-cli-fastboot',

  init() {
    this._super.init && this._super.init.apply(this, arguments);

    this.emitter = new EventEmitter();
  },

  includedCommands: function() {
    return {
      'fastboot':       require('./lib/commands/fastboot')(this),

      /* fastboot:build is deprecated and will be removed in a future version */
      'fastboot:build': require('./lib/commands/fastboot-build')
    };
  },

  on: function() {
    this.emitter.on.apply(this.emitter, arguments);
  },

  emit: function() {
    this.emitter.emit.apply(this.emitter, arguments);
  },

  /**
   * Called at the start of the build process to let the addon know it will be
   * used. At this point, we can rely on the EMBER_CLI_FASTBOOT environment
   * variable being set.
   *
   * Once we've determined which mode we're in (browser build or FastBoot build),
   * we mixin additional Ember addon hooks appropriate to the current build target.
   */
  included: function(app) {
    patchEmberApp(app);

    // get the app registry object and app name so that we can build the fastboot
    // tree
    this._appRegistry = app.registry;
    this._name = app.name;
  },

  config: function() {
    if (this.app && this.app.options.__is_building_fastboot__) {
      return { APP: { autoboot: false } };
    }
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
      return fastbootAppModule(config.modulePrefix);
    }

    if (type === 'config-module' && this.app.options.__is_building_fastboot__) {
      var linesToRemove = contents.length;
      while(linesToRemove) {
        // Clear out the default config from ember-cli
        contents.pop();
        linesToRemove--;
      }

      return 'return FastBoot.config();';
    }
  },

  treeForApp: function(defaultTree) {
    var trees = [defaultTree];

    if (this._getEmberVersion().lt('2.10.0-alpha.1')) {
      trees.push(this.treeGenerator(path.resolve(this.root, 'app-lt-2-9')));
    }

    return mergeTrees(trees, { overwrite: true });
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
          destDir: appName + '-fastboot'
        });

        fastbootTrees.push(fastbootTree);
      }
    });

    // check the parent containing the fastboot directory
    var projectFastbootPath = path.join(this.project.root, 'fastboot');
    if (existsSync(projectFastbootPath)) {
      var fastbootTree = new Funnel(projectFastbootPath, {
        destDir: appName + '-fastboot'
      });

      fastbootTrees.push(fastbootTree);
    }

    var fastbootTree = new BroccoliMergeTrees(fastbootTrees);

    var processExtraTree = p.preprocessJs(fastbootTree, '/', this._name, {
      registry: this._appRegistry
    });

    // TODO: this file needs to be added in fastboot package.json when
    var finalFastbootTree = Concat(processExtraTree, {
      outputFile: 'assets/' + appName + '-fastboot.js'
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

    let newTree = new BroccoliMergeTrees(trees);

    return newTree;
  },

  /**
   * Filters out initializers and instance initializers that should only run in
   * browser mode.
   */
  preconcatTree: function(tree) {
    return filterInitializers(tree, this.app.name);
  },

  /**
   * After the entire Broccoli tree has been built for the `dist` directory,
   * adds the `fastboot-config.json` file to the root.
   *
   * FASTBOOT_DISABLED is a pre 1.0 power user flag to
   * disable the fastboot build while retaining the fastboot service.
   */
  postprocessTree: function(type, tree) {
    if (type === 'all' && !process.env.FASTBOOT_DISABLED) {
      var fastbootTree = this.buildFastBootTree();

      // Merge the package.json with the existing tree
      return mergeTrees([tree, fastbootTree], {overwrite: true});
    }

    return tree;
  },

  buildFastBootTree: function() {
    var fastbootBuild = new FastBootBuild({
      ui: this.ui,
      assetMapPath: this.assetMapPath,
      project: this.project,
      app: this.app,
      parent: this.parent
    });

    return fastbootBuild.toTree();
  },

  outputReady: function() {
    this.emit('outputReady');
  },

  postBuild: function() {
    this.emit('postBuild');
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
