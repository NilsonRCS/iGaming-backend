# Arquitetura — Jungle Gaming Wagering Processor

## Autenticação

**Decisão: B — não implementar agora, deixar o ponto de extensão.**

O enunciado (seção 3) define que autenticação não vale pontos e não deve competir com as partes críticas (correção financeira, concorrência, idempotência, mensageria). Subir um IdP (Keycloak ou Zitadel) traria mais um serviço ao Docker Compose, configuração de realm/clients e emissão de tokens nos testes, sem melhorar nenhuma das garantias avaliadas. Por isso a API não exige credencial hoje, mas toda rota HTTP já passa por um guard cuja decisão é delegada a uma porta substituível.

### Peças

| Peça | Arquivo | Papel |
|------|---------|-------|
| `AuthGuard` | `src/infrastructure/http/auth/auth.guard.ts` | Guard global (`APP_GUARD`). Rotas marcadas com `@Public()` passam direto. As demais são decididas pelo `RequestAuthenticator`; recusa vira `401 {"error":"UNAUTHORIZED"}` |
| `RequestAuthenticator` | `src/infrastructure/http/auth/request-authenticator.ts` | Porta (token `REQUEST_AUTHENTICATOR`) que recebe os headers da requisição e responde se ela é autêntica. **É o ponto de extensão** |
| `NoopRequestAuthenticator` | mesmo arquivo | Implementação atual: aceita tudo |
| `@Public()` | `src/infrastructure/http/auth/public.decorator.ts` | Marca `/health/live`, `/health/ready` e `/metrics` |

### Como ligar um IdP

Basta registrar outra implementação de `RequestAuthenticator` no `AuthModule`, por exemplo uma que leia `Authorization: Bearer <jwt>` e valide assinatura, emissor, audiência e expiração contra o JWKS do Keycloak ou do Zitadel. Controllers, casos de uso e o próprio guard não mudam. O teste `test/integration/auth.spec.ts` faz exatamente essa troca com um autenticador de exemplo e comprova que as rotas de negócio passam a responder 401 sem credencial, enquanto health checks e métricas continuam abertos.

### Regras da seção 3

| Regra | Como é garantida |
|-------|------------------|
| `/health/*` ficam abertos | `@Public()` no `HealthController`. O guard libera antes de consultar o autenticador, então a regra continua valendo quando houver autenticação real |
| Mensagens da fila são canal interno confiável | O consumidor SQS não passa por guard HTTP. A confiança vem de quem tem acesso à fila (IAM e rede), não de credencial na mensagem |
| Identidade do provedor na mensagem segue as validações de domínio | `providerId` é obrigatório na validação do caso de uso, e uma referência só é aceita se pertencer ao mesmo provedor, jogador, wallet e rodada (seção 7.2). HTTP e fila usam o mesmo caso de uso, então a regra é idêntica nas duas entradas |

`/metrics` também é público para o Prometheus raspar sem credencial. A proteção esperada para ele é de rede: a porta não deve ser exposta publicamente.
