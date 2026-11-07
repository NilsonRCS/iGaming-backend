import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import mikroOrmConfig from './mikro-orm.config';
import { HttpApiModule } from './infrastructure/http/http-api.module';
import { MessagingModule } from './infrastructure/messaging/messaging.module';
import { ObservabilityModule } from './infrastructure/observability/observability.module';
import { MonitoringModule } from './infrastructure/health/monitoring.module';

@Module({
  imports: [
    MikroOrmModule.forRoot(mikroOrmConfig),
    ObservabilityModule,
    HttpApiModule,
    MessagingModule,
    MonitoringModule,
  ],
})
export class AppModule {}
