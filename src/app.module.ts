import { Module } from '@nestjs/common';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import mikroOrmConfig from './mikro-orm.config';
import { WageringModule } from './infrastructure/wagering.module';

@Module({
  imports: [
    MikroOrmModule.forRoot(mikroOrmConfig),
    WageringModule,
  ],
})
export class AppModule {}
