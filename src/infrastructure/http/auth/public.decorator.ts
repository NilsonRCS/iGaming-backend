import { SetMetadata } from '@nestjs/common';

export const IS_PUBLIC = 'auth:isPublic';

/** Rota aberta mesmo quando houver autenticação real (seção 3: `/health/*` ficam abertos). */
export const Public = () => SetMetadata(IS_PUBLIC, true);
