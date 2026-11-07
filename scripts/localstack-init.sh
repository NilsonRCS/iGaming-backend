#!/bin/bash
# Inicializa as filas SQS no LocalStack

set -e

DLQ_NAME=wager-transactions-dlq.fifo
QUEUE_NAME=wager-transactions.fifo
EVENTS_QUEUE_NAME=wager-events.fifo
DLQ_ARN="arn:aws:sqs:us-east-1:000000000000:${DLQ_NAME}"

echo "==> Criando filas SQS no LocalStack..."

awslocal sqs create-queue \
  --queue-name "${DLQ_NAME}" \
  --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"true"}'

# Atributos em JSON: a forma abreviada (Chave=Valor,...) não aceita o JSON
# aninhado da RedrivePolicy.
awslocal sqs create-queue \
  --queue-name "${QUEUE_NAME}" \
  --attributes "{\"FifoQueue\":\"true\",\"ContentBasedDeduplication\":\"true\",\"RedrivePolicy\":\"{\\\"deadLetterTargetArn\\\":\\\"${DLQ_ARN}\\\",\\\"maxReceiveCount\\\":\\\"5\\\"}\"}"

# Destino dos eventos de integração publicados pelo outbox (seção 11).
# Dedup pelo MessageDeduplicationId explícito (= eventId), não pelo conteúdo.
awslocal sqs create-queue \
  --queue-name "${EVENTS_QUEUE_NAME}" \
  --attributes '{"FifoQueue":"true","ContentBasedDeduplication":"false"}'

echo "==> Filas criadas:"
awslocal sqs list-queues

echo "==> LocalStack pronto!"
