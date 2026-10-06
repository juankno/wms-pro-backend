import { Module } from '@nestjs/common';
import { SequencesController } from './sequences.controller';

@Module({ controllers: [SequencesController] })
export class SequencesModule {}
