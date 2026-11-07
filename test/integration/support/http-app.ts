import { Test } from '@nestjs/testing';
import { MikroOrmModule } from '@mikro-orm/nestjs';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import { HttpApiModule } from '../../../src/infrastructure/http/http-api.module';
import { TestDatabase } from './test-database';

/** App Nest real (Fastify + filtros + controllers) sobre o banco descartável; sem rede, via inject(). */
export async function createHttpApp(db: TestDatabase): Promise<NestFastifyApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [MikroOrmModule.forRoot(db.options), HttpApiModule],
  }).compile();

  const app = moduleRef.createNestApplication<NestFastifyApplication>(new FastifyAdapter(), { logger: false });
  await app.init();
  await app.getHttpAdapter().getInstance().ready();
  return app;
}
