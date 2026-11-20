import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Inject,
  Param,
  Post,
  UploadedFile,
  UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { extname, join } from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { appConfig, AppConfig } from '../config/app.config';
import { RagService } from './rag.service';
import { AddTextDto } from './dto/add-text.dto';

/** 纯文本类扩展名；二进制格式（pdf/docx）需要额外解析器，见 README「扩展 RAG」 */
const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.csv', '.tsv', '.json', '.jsonl',
  '.log', '.py', '.ts', '.js', '.html', '.htm', '.xml', '.yml', '.yaml', '.sql',
]);

@Controller('api/rag')
export class RagController {
  constructor(
    private readonly rag: RagService,
    @Inject(appConfig.KEY) private readonly cfg: AppConfig,
  ) {}

  @Get('documents')
  list() {
    return { documents: this.rag.listDocuments(), stats: this.rag.stats() };
  }

  @Post('text')
  async addText(@Body() dto: AddTextDto) {
    const doc = await this.rag.ingest(`${dto.title?.trim() || 'pasted-text'}.md`, dto.text);
    return { ok: true, document: doc };
  }

  @Post('upload')
  @UseInterceptors(FileInterceptor('file'))
  async upload(@UploadedFile() file?: Express.Multer.File) {
    if (!file) throw new BadRequestException('缺少文件字段 file');

    const ext = extname(file.originalname).toLowerCase();
    if (!TEXT_EXTENSIONS.has(ext)) {
      throw new BadRequestException(
        `暂不支持 ${ext || '未知'} 格式。当前支持：${[...TEXT_EXTENSIONS].join(' ')}`,
      );
    }
    if (file.buffer.includes(0)) {
      throw new BadRequestException('文件看起来是二进制内容，请上传纯文本');
    }

    const text = file.buffer.toString('utf-8');
    if (!text.trim()) throw new BadRequestException('文件内容为空');

    // 留一份原始文件，便于追溯
    const uploads = this.cfg.paths.uploads;
    await mkdir(uploads, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    await writeFile(join(uploads, `${stamp}-${file.originalname}`), file.buffer);

    const doc = await this.rag.ingest(file.originalname, text);
    return { ok: true, document: doc };
  }

  @Delete('documents/:docId')
  async remove(@Param('docId') docId: string) {
    const removed = await this.rag.deleteDocument(docId);
    if (removed === 0) throw new BadRequestException(`文档 ${docId} 不存在`);
    return { ok: true, removedChunks: removed };
  }

  @Post('clear')
  async clear() {
    await this.rag.clear();
    return { ok: true };
  }
}
