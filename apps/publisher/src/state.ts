export type OutboxStatus = 'PENDING' | 'IN_FLIGHT' | 'PUBLISHED' | 'FAILED';

export const nextOutboxStatusOnPublish = (current: OutboxStatus, success: boolean): OutboxStatus => {
  if (success) {
    return 'PUBLISHED';
  }

  if (current === 'PUBLISHED') {
    return 'PUBLISHED';
  }

  return 'FAILED';
};
