import { BuildContext, TaskInfo } from './util/interfaces';
import { BuildError, Logger } from './util/logger';
import { emit, EventType } from './util/events';
import { endsWith, setModulePathsCache } from './util/helpers';
import { fillConfigDefaults, generateContext, getUserConfigFile, replacePathVars } from './util/config';
import { ionCompiler } from './plugins/ion-compiler';
import { join, isAbsolute, normalize } from 'path';
import * as rollupBundler from 'rollup';


export function rollup(context: BuildContext, configFile: string) {
  context = generateContext(context);
  configFile = getUserConfigFile(context, taskInfo, configFile);

  const logger = new Logger('rollup');

  return rollupWorker(context, configFile)
    .then(() => {
      logger.finish();
    })
    .catch(err => {
      throw logger.fail(err);
    });
}


export function rollupUpdate(event: string, filePath: string, context: BuildContext) {
  const logger = new Logger('rollup update');

  const configFile = getUserConfigFile(context, taskInfo, null);

  return rollupWorker(context, configFile)
    .then(() => {
      logger.finish();
    })
    .catch(err => {
      throw logger.fail(err);
    });
}


export function rollupWorker(context: BuildContext, configFile: string): Promise<any> {
  return new Promise((resolve, reject) => {
    let rollupConfig = getRollupConfig(context, configFile);

    rollupConfig.dest = getOutputDest(context, rollupConfig);

    // replace any path vars like {{TMP}} with the real path
    rollupConfig.entry = replacePathVars(context, normalize(rollupConfig.entry));
    rollupConfig.dest = replacePathVars(context, normalize(rollupConfig.dest));

    if (!context.isProd) {
      // ngc does full production builds itself and the bundler
      // will already have receive transpiled and AoT templates

      // dev mode auto-adds the ion-compiler plugin, which will inline
      // templates and transpile source typescript code to JS before bundling
      rollupConfig.plugins.unshift(
        ionCompiler(context)
      );
    }

    if (context.useBundleCache) {
      // tell rollup to use a previous bundle as its starting point
      rollupConfig.cache = cachedBundle;
    }

    if (!rollupConfig.onwarn) {
      // use our own logger if one wasn't already provided
      rollupConfig.onwarn = createOnWarnFn();
    }

    Logger.debug(`entry: ${rollupConfig.entry}, dest: ${rollupConfig.dest}, cache: ${rollupConfig.cache}, format: ${rollupConfig.format}`);

    checkDeprecations(context, rollupConfig);

    // bundle the app then create create css
    rollupBundler.rollup(rollupConfig)
      .then((bundle: RollupBundle) => {

        Logger.debug(`bundle.modules: ${bundle.modules.length}`);

        // set the module files used in this bundle
        // this reference can be used elsewhere in the build (sass)
        context.moduleFiles = bundle.modules.map((m) => m.id);

        // async cache all the module paths so we don't need
        // to always bundle to know which modules are used
        setModulePathsCache(context.moduleFiles);

        // cache our bundle for later use
        if (context.isWatch) {
          cachedBundle = bundle;
        }

        // write the bundle
        return bundle.write(rollupConfig);
      })
      .then(() => {
        // clean up any references (overkill yes, but let's play it safe)
        emit(EventType.FileChange, context, rollupConfig.dest);
        rollupConfig = rollupConfig.cache = rollupConfig.onwarn = rollupConfig.plugins = null;

        resolve();
      })
      .catch((err: any) => {
        // ensure references are cleared up when there's an error
        cachedBundle = rollupConfig = rollupConfig.cache = rollupConfig.onwarn = rollupConfig.plugins = null;
        reject(new BuildError(err));
      });
  });
}


export function getRollupConfig(context: BuildContext, configFile: string): RollupConfig {
  configFile = getUserConfigFile(context, taskInfo, configFile);
  return fillConfigDefaults(configFile, taskInfo.defaultConfigFile);
}


export function getOutputDest(context: BuildContext, rollupConfig: RollupConfig) {
  if (!isAbsolute(rollupConfig.dest)) {
    // user can pass in absolute paths
    // otherwise save it in the build directory
    return join(context.buildDir, rollupConfig.dest);
  }
  return rollupConfig.dest;
}


function checkDeprecations(context: BuildContext, rollupConfig: RollupConfig) {
  if (!context.isProd) {
    if (rollupConfig.entry.indexOf('.tmp') > -1 || endsWith(rollupConfig.entry, '.js')) {
      // warning added 2016-10-05, v0.0.29
      throw new BuildError('\nDev builds no longer use the ".tmp" directory. Please update your rollup config\'s\n' +
                           'entry to use your "src" directory\'s "main.dev.ts" TypeScript file.\n' +
                           'For example, the entry for dev builds should be: "src/app/main.dev.ts"');

    }
  }
}


let cachedBundle: RollupBundle = null;


function createOnWarnFn() {
  const previousWarns: {[key: string]: boolean} = {};

  return function onWarningMessage(msg: string) {
    if (msg in previousWarns) {
      return;
    }
    previousWarns[msg] = true;

    if (!(IGNORE_WARNS.some(warnIgnore => msg.indexOf(warnIgnore) > -1))) {
      Logger.warn(`rollup: ${msg}`);
    }
  };
}

const IGNORE_WARNS = [
  'keyword is equivalent to'
];


const taskInfo: TaskInfo = {
  fullArgConfig: '--rollup',
  shortArgConfig: '-r',
  envConfig: 'ionic_rollup',
  defaultConfigFile: 'rollup.config'
};


export interface RollupConfig {
  // https://github.com/rollup/rollup/wiki/JavaScript-API
  entry?: string;
  sourceMap?: boolean;
  plugins?: any[];
  format?: string;
  dest?: string;
  cache?: RollupBundle;
  onwarn?: Function;
}


export interface RollupBundle {
  // https://github.com/rollup/rollup/wiki/JavaScript-API
  write?: Function;
  modules: RollupModule[];
}


export interface RollupModule {
  id: string;
}
