import type { Model } from '@core/model';
import { loadModel } from '../core/index';
import 'react';
export function handle(): Model { return loadModel(); }
