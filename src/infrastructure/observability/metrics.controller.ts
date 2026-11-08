import { Controller, Get, Header, Res } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { Metrics } from './metrics';
import { Public } from '../http/auth/public.decorator';

/** Formato de exposição do Prometheus. Aberto como os health checks; proteção de rede (porta interna). */
@Public()
@Controller()
export class MetricsController {
  constructor(private readonly metrics: Metrics) {}

  @Get('metrics')
  @Header('Cache-Control', 'no-store')
  async scrape(@Res({ passthrough: true }) reply: FastifyReply): Promise<string> {
    reply.header('Content-Type', this.metrics.contentType);
    return this.metrics.render();
  }
}
