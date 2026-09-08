export default function Placeholder({ title }: { title: string }) {
	return (
		<section>
			<h1 className="font-serif text-2xl">{title}</h1>
			<p className="mt-2 text-sm text-ink-soft">Not ported yet.</p>
		</section>
	);
}
