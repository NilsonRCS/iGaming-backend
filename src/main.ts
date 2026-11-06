import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import {
  FastifyAdapter,
  NestFastifyApplication,
} from '@nestjs/platform-fastify';
import { AppModule } from './app.module';

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(
    AppModule,
    new FastifyAdapter({ logger: true }),
  );

  const port = process.env.APP_PORT ?? 3000;
  await app.listen(port, '0.0.0.0');

  console.log(`🚀 iGaming Backend running on port ${port}`);
}

bootstrap();
