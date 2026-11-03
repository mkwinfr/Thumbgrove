import type { ReviewRecord } from '../../shared/api'

export type { Candidate, Draft } from '../../shared/api'

export type ViewName = 'folders' | 'review' | 'characters' | 'discord' | 'catalogues'

export type ReviewItem = ReviewRecord

export type ExitKind = 'apply' | 'skip' | 'delete' | 'next' | 'previous'
