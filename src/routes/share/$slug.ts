import {createFileRoute} from '@tanstack/react-router';
import {handleReportShare} from '../../server/reports.ts';

export const Route = createFileRoute('/share/$slug')({
  server:{handlers:{GET:({request})=>handleReportShare(request),HEAD:({request})=>handleReportShare(request)}},
});
