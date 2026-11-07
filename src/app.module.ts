import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import mikroOrmConfig from './mikro-orm.config';
import { HttpApiModule } from './infrastructure/http/http-api.module';

@Module({
  imports: [
    MikroOrmModule.forRoot(mikroOrmConfig),
    HttpApiModule,
  ],
})
export class AppModule {}
