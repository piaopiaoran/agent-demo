import 'reflect-metadata';
import { Logger, ValidationPipe } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  // DTO 校验：多余字段丢弃，query/body 类型自动转换
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidUnknownValues: false,
    }),
  );

  app.enableCors({ origin: true, credentials: true });

  const config = app.get(ConfigService);
  const port = config.get<number>('app.port') ?? 3000;
  const host = config.get<string>('app.host') ?? '0.0.0.0';

  await app.listen(port, host);
  Logger.log(`监听 ${host}:${port}，本机打开 http://127.0.0.1:${port} 开始对话`, 'Bootstrap');
}

void bootstrap();
