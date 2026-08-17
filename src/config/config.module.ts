import { Global, Module } from '@nestjs/common';
import { APP_CONFIG, loadAppConfig } from './app-config';

/**
 * Global so that services can inject the validated config without every module
 * re-importing it. Deliberately not @nestjs/config: the loader here is typed, fails at
 * boot with a list of every problem at once, and keeps process.env in a single file.
 */
@Global()
@Module({
  providers: [{ provide: APP_CONFIG, useFactory: () => loadAppConfig() }],
  exports: [APP_CONFIG],
})
export class ConfigModule {}
