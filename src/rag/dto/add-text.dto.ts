import { IsNotEmpty, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export class AddTextDto {
  @IsString()
  @IsNotEmpty({ message: 'text 不能为空' })
  @MinLength(10, { message: '文本至少 10 个字符' })
  @MaxLength(500_000, { message: '单次最多 50 万字符，请拆分' })
  text!: string;

  @IsOptional()
  @IsString()
  @MaxLength(120)
  title?: string;
}
