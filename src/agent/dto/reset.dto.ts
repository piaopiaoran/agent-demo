import { IsNotEmpty, IsString, Matches } from 'class-validator';

export class ResetDto {
  @IsString()
  @IsNotEmpty()
  @Matches(/^[A-Za-z0-9_-]{1,64}$/)
  threadId!: string;
}
