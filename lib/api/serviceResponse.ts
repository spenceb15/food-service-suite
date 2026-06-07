import { NextResponse } from 'next/server';
import { ServiceError } from '../services/errors';

export function serviceErrorResponse(error: unknown): NextResponse {
  if (error instanceof ServiceError) {
    if (error.status === 401) {
      return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
    }

    if (error.status === 403) {
      return NextResponse.json({ error: 'Forbidden' }, { status: 403 });
    }

    if (error.status === 503) {
      return NextResponse.json(
        { error: 'Please retry the same operation.' },
        { status: 503 }
      );
    }

    return NextResponse.json(
      { error: error.message },
      { status: error.status }
    );
  }

  return NextResponse.json(
    { error: 'Internal server error' },
    { status: 500 }
  );
}
