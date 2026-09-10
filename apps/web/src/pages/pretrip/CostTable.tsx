import { IconButton } from '../../components/ui/buttons';
import type { CostItem } from './types';
import { cap } from './labels';
import { copy } from '../../copy';

const c = copy.preparation.costTable;

/** The estimates, as a table with the trip total in its foot. */
export default function CostTable({
	items,
	total,
	fmt,
	onEdit,
	onRemove
}: {
	items: CostItem[];
	total: number;
	fmt: (cents: number) => string;
	onEdit: (it: CostItem) => void;
	onRemove: (it: CostItem) => void;
}) {
	const CELL = 'border-b border-line px-4 py-2.5 text-left text-[0.92rem]';
	const TH =
		'border-b border-line px-4 py-2.5 text-left text-[0.72rem] font-medium tracking-[0.06em] text-ink-faint uppercase';

	return (
		<div className="card overflow-hidden p-0">
			<table className="w-full table-fixed border-collapse">
				<thead>
					<tr>
						<th className={TH}>{c.item}</th>
						<th className={`${TH} w-[22%]`}>{c.category}</th>
						<th className={`${TH} w-[18%]`}>{c.city}</th>
						<th className={`${TH} w-[16%] text-right`}>{c.amount}</th>
						<th className={`${TH} w-22`} />
					</tr>
				</thead>
				<tbody>
					{items.map((it) => (
						<tr key={it.id} className="hover:bg-surface-2">
							<td className={`${CELL} truncate`} title={it.label}>
								{it.label}
							</td>
							<td className={CELL}>
								<span className="chip text-[0.74rem]">{cap(it.category)}</span>
							</td>
							<td className={`${CELL} muted truncate`} title={it.cityName ?? c.noCity}>
								{it.cityName ?? c.noCity}
							</td>
							<td className={`${CELL} text-right font-semibold tabular-nums`}>
								{fmt(it.amountCents)}
							</td>
							<td className={`${CELL} text-right`}>
								<span className="inline-flex justify-end gap-1">
									<IconButton label={c.editLabel(it.label)} onClick={() => onEdit(it)}>
										✎
									</IconButton>
									<IconButton label={c.removeLabel(it.label)} danger onClick={() => onRemove(it)}>
										✕
									</IconButton>
								</span>
							</td>
						</tr>
					))}
					{items.length === 0 && (
						<tr>
							<td colSpan={5} className={`${CELL} muted`}>
								{c.empty}
							</td>
						</tr>
					)}
				</tbody>
				<tfoot>
					<tr className="bg-surface-2 font-medium">
						<td colSpan={3} className="px-4 py-2.5 text-[0.92rem]">
							{c.total}
						</td>
						<td className="px-4 py-2.5 text-right text-[0.92rem] font-semibold tabular-nums">
							{fmt(total)}
						</td>
						<td />
					</tr>
				</tfoot>
			</table>
		</div>
	);
}
