import { IsNotEmpty, IsOptional, IsString, Matches, MaxLength } from 'class-validator';

export class ChatDto {
  @IsString()
  @IsNotEmpty({ message: '消息不能为空' })
  @MaxLength(20_000, { message: '单条消息最长 2 万字' })
  message!: string;

  /** 前端生成的会话 id；同一 id 的多轮对话共享记忆 */
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z0-9_-]{1,64}$/, { message: 'threadId 只能是字母、数字、下划线或短横线' })
  threadId?: string;
}
