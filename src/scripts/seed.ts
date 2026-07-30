import { connectDB } from "../lib/db";
import { Paragraph } from "../models/Paragraph";
import { Word } from "../models/Word";
import { ParagraphWord } from "../models/ParagraphWord";

async function seed() {
  await connectDB();

  await Word.deleteMany({});
  await Paragraph.deleteMany({});
  await ParagraphWord.deleteMany({});

  // ── Paragraphs (all contain "dog" for the test) ──

  await Paragraph.create([
    {
      title: "The Dog",
      content:
        "The dog ran through the meadow, its fur rippling like wheat in the wind. " +
        "A profound silence followed as it vanished into the thicket, leaving only " +
        "the faint trace of its ephemeral presence.",
      topic: "environment",
      wordCount: 34,
    },
    {
      title: "A Loyal Dog",
      content:
        "A well-trained dog can provide companionship and emotional support to its owner. " +
        "Studies show that dog owners tend to have lower blood pressure and reduced stress " +
        "levels, making the dog an ideal partner for mental health improvement.",
      topic: "society_health",
      wordCount: 39,
    },
    {
      title: "Dog Training",
      content:
        "Teaching a dog basic commands requires patience and consistency. Positive reinforcement " +
        "is widely regarded as the most effective method for shaping a dog's behaviour, " +
        "as it builds trust between the dog and its handler over time.",
      topic: "education",
      wordCount: 38,
    },
    {
      title: "Dogs in the Workplace",
      content:
        "Many tech companies now allow employees to bring their dog to the office. " +
        "A friendly dog roaming the workspace can boost morale and encourage social " +
        "interaction among colleagues, though some worry about allergies and distractions.",
      topic: "work_business",
      wordCount: 37,
    },
  ]);

  const paragraphs = await Paragraph.find();

  // ── Pre-seeded unfamiliar words (NOT "dog" — user marks it during test) ──

  const words = [
    { word: "meadow", definition: "A field with grass and flowers, often used for hay." },
    { word: "rippling", definition: "Moving in small waves; having a wavy motion." },
    { word: "thicket", definition: "A dense group of bushes or small trees." },
    { word: "profound", definition: "Very great or intense; having deep meaning." },
    { word: "ephemeral", definition: "Lasting for a very short time; fleeting." },
    { word: "companionship", definition: "The feeling of friendship and support from being with someone." },
    { word: "reinforcement", definition: "The process of encouraging a behaviour by reward or punishment." },
    { word: "consistent", definition: "Always acting or behaving in the same way." },
    { word: "morale", definition: "The confidence and enthusiasm of a group of people." },
    { word: "distraction", definition: "Something that takes attention away from what one is doing." },
  ];

  for (let i = 0; i < words.length; i++) {
    // Spread words across different paragraphs
    const paragraphId = paragraphs[i % paragraphs.length]._id;
    await Word.create({
      ...words[i],
      status: "unfamiliar",
      markedFrom: [paragraphId],
      timesMet: 1,
      unfamiliarity: 1,
    });
  }

  console.log("Seed complete!");
  console.log(`  Paragraphs: ${await Paragraph.countDocuments()}`);
  console.log(`  Words: ${await Word.countDocuments()}`);

  process.exit(0);
}

seed();
