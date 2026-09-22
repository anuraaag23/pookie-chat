import { Controller, Get, Header, Param, Post, Query, Req, Res, UseGuards, BadRequestException } from '@nestjs/common';
import type { Request, Response } from 'express';
import { AttachmentsService } from './attachments.service';
import { UploadQueryDto } from './dto/attachments.dto';
import { AccessTokenGuard, AuthenticatedRequest } from '../auth/access-token.guard';

async function readRawBody(req: Request, limitBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > limitBytes) throw new BadRequestException('File too large');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

@UseGuards(AccessTokenGuard)
@Controller('api/attachments')
export class AttachmentsController {
  constructor(private readonly attachments: AttachmentsService) {}

  // The client sends the already-encrypted file as the raw request body —
  // this endpoint never sees, and could not decrypt even if it wanted to,
  // the plaintext file.
  @Post('upload')
  async upload(@Req() req: AuthenticatedRequest & Request, @Query() query: UploadQueryDto) {
    const bytes = await readRawBody(req, 25 * 1024 * 1024);
    return this.attachments.upload(req.auth.userId, query.conversationId, bytes, query.mimeTypeHint, query.originalSize);
  }

  @Get(':id')
  @Header('Content-Type', 'application/octet-stream')
  async download(@Req() req: AuthenticatedRequest, @Param('id') id: string, @Res() res: Response) {
    const { bytes, encryptedDek, mimeTypeHint } = await this.attachments.download(req.auth.userId, id);
    res.setHeader('X-Encrypted-Dek', encryptedDek ?? '');
    res.setHeader('X-Mime-Type-Hint', mimeTypeHint);
    res.send(bytes);
  }
}
