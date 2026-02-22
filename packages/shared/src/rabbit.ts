import { connect, type Channel, type ChannelModel, type ConfirmChannel, type ConsumeMessage } from 'amqplib';
import { env } from './config.js';

export const EXCHANGE = 'events.exchange';
export const MAIN_QUEUE = 'events.main';
export const RETRY_QUEUE = 'events.retry';
export const DLQ_QUEUE = 'events.dlq';

export type RabbitBundle = {
  connection: ChannelModel;
  channel: Channel;
  confirmChannel: ConfirmChannel;
};

export const initRabbit = async (): Promise<RabbitBundle> => {
  const connection = await connect(env.RABBITMQ_URL);
  const channel = await connection.createChannel();
  const confirmChannel = await connection.createConfirmChannel();

  await Promise.all([
    channel.assertExchange(EXCHANGE, 'direct', { durable: true }),
    channel.assertQueue(MAIN_QUEUE, { durable: true }),
    channel.assertQueue(RETRY_QUEUE, {
      durable: true,
      arguments: {
        'x-dead-letter-exchange': EXCHANGE,
        'x-dead-letter-routing-key': MAIN_QUEUE,
      },
    }),
    channel.assertQueue(DLQ_QUEUE, { durable: true }),
  ]);

  await Promise.all([
    channel.bindQueue(MAIN_QUEUE, EXCHANGE, MAIN_QUEUE),
    channel.bindQueue(RETRY_QUEUE, EXCHANGE, RETRY_QUEUE),
    channel.bindQueue(DLQ_QUEUE, EXCHANGE, DLQ_QUEUE),
  ]);

  return { connection, channel, confirmChannel };
};

export const publishConfirm = async (
  channel: ConfirmChannel,
  routingKey: string,
  payload: Record<string, unknown>,
  options: Record<string, unknown> = {},
): Promise<void> => {
  await new Promise<void>((resolve, reject) => {
    channel.publish(
      EXCHANGE,
      routingKey,
      Buffer.from(JSON.stringify(payload)),
      {
        persistent: true,
        contentType: 'application/json',
        ...options,
      },
      (error) => {
        if (error) {
          reject(error);
          return;
        }
        resolve();
      },
    );
  });
};

export const parseMessage = <T>(msg: ConsumeMessage): T => JSON.parse(msg.content.toString('utf8')) as T;
