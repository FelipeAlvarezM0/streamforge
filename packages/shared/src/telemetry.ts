import { context, trace, SpanStatusCode } from '@opentelemetry/api';
import { Resource } from '@opentelemetry/resources';
import { SemanticResourceAttributes } from '@opentelemetry/semantic-conventions';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { env } from './config.js';

const provider = new NodeTracerProvider({
  resource: new Resource({
    [SemanticResourceAttributes.SERVICE_NAMESPACE]: env.OTEL_SERVICE_NAMESPACE,
    [SemanticResourceAttributes.SERVICE_NAME]: env.OTEL_SERVICE_NAME,
  }),
});

provider.register();

export const tracer = trace.getTracer('streamforge');

export const withSpan = async <T>(name: string, attrs: Record<string, string | number>, fn: () => Promise<T>): Promise<T> => {
  const span = tracer.startSpan(name, { attributes: attrs });
  try {
    const result = await context.with(trace.setSpan(context.active(), span), fn);
    span.setStatus({ code: SpanStatusCode.OK });
    return result;
  } catch (error) {
    span.recordException(error as Error);
    span.setStatus({ code: SpanStatusCode.ERROR });
    throw error;
  } finally {
    span.end();
  }
};
