"""Unit tests for the AI helper (offline parts only; no network needed)."""
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
import ai  # noqa: E402


class OfflineConverterTest(unittest.TestCase):
    def convert(self, text):
        dsl, error = ai.offline_nl_to_dsl(text)
        self.assertIsNone(error, error)
        result = ai.compile_check(dsl)
        self.assertTrue(result["success"], result["errors"])
        return dsl

    def test_problem_statement_example(self):
        dsl = self.convert("If the temperature is above 30 and the door is open, turn on the fan.")
        self.assertIn("IF temperature > 30 AND door == OPEN", dsl)
        self.assertIn("THEN turn_on(fan)", dsl)

    def test_otherwise_and_set_level(self):
        dsl = self.convert("When motion is detected or humidity drops below 40, switch on the light "
                           "and set the ac to 22, otherwise switch the light off")
        self.assertIn("motion == ON OR humidity < 40", dsl)
        self.assertIn("set_level(ac, 22)", dsl)
        self.assertIn("ELSE turn_off(light)", dsl)

    def test_action_first_and_multiword_names(self):
        dsl = self.convert("Turn on the pump when soil moisture is less than 35")
        self.assertIn("SENSOR soil_moisture : NUMBER", dsl)
        self.assertIn("IF soil_moisture < 35", dsl)

    def test_at_most(self):
        self.assertIn("light_level <= 200", self.convert("If the light level is at most 200, turn on lamp"))

    def test_not_understood(self):
        dsl, error = ai.offline_nl_to_dsl("make me a sandwich")
        self.assertIsNone(dsl)
        self.assertIn("condition", error)


class HelpersTest(unittest.TestCase):
    def test_clean_output_strips_think_and_fences(self):
        raw = "<think>hmm</think>Here is the DSL:\n```\nDEVICE fan\nSENSOR t : NUMBER\n```\nDone."
        self.assertEqual(ai.clean_output(raw), "DEVICE fan\nSENSOR t : NUMBER\n")

    def test_existing_declarations(self):
        src = "SENSOR t : NUMBER\nDEVICE fan, light\nIF t > 1 THEN turn_on(fan)\n"
        self.assertEqual(ai.existing_declarations(src), ["SENSOR t : NUMBER", "DEVICE fan, light"])

    def test_offline_explain_new_warnings(self):
        self.assertIn("ELSE IF", ai.offline_explain("this ELSE IF can never run: whenever ..."))
        self.assertIn("overrides", ai.offline_explain("conflict: rule 2 turns 'fan' off while rule 1 ..."))
        self.assertIn("same time", ai.offline_explain("this condition can never be true, so its actions never run"))
        self.assertIn("numbers", ai.offline_explain("arithmetic '+' needs numbers, but state OPEN is not a number"))

    def test_offline_explain(self):
        text = ai.offline_explain("'fan' is not a registered device")
        self.assertIn("DEVICE fan", text)
        self.assertIn("Fix:", text)



class MeaningCheckTest(unittest.TestCase):
    """The AI's DSL must keep the sentence's meaning, not just compile."""
    sentence = "if the temperature is above 30 and the door is open, turn on the fan"

    def test_dropped_condition_is_caught(self):
        # A real answer from a local model: compiles, but loses "30" and the door.
        dsl = "SENSOR temperature : NUMBER\nSENSOR door : STATE\nDEVICE fan\n\nIF temperature > 3\nTHEN turn_on(fan)\n"
        problems = ai.meaning_problems(self.sentence, ai.compile_check(dsl))
        self.assertTrue(any("30" in p for p in problems), problems)
        self.assertTrue(any("door" in p for p in problems), problems)

    def test_faithful_answer_passes(self):
        dsl = "SENSOR temperature : NUMBER\nSENSOR door : STATE\nDEVICE fan\n\nIF temperature > 30 AND door == OPEN\nTHEN turn_on(fan)\n"
        self.assertEqual(ai.meaning_problems(self.sentence, ai.compile_check(dsl)), [])


if __name__ == "__main__":
    unittest.main()
